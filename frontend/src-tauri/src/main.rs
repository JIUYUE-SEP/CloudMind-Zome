#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// ------------------------------------------------------------------
// Windows Job Object: kills child Python when parent dies
// ------------------------------------------------------------------
#[cfg(windows)]
mod job {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use winapi::shared::minwindef::DWORD;
    use winapi::um::jobapi2::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    };
    use winapi::um::winnt::{
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JobObjectExtendedLimitInformation,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    pub type JobHandle = winapi::um::winnt::HANDLE;

    pub fn create() -> Option<JobHandle> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &mut info as *mut _ as *mut _,
                std::mem::size_of_val(&info) as DWORD,
            );
            if ok == 0 {
                return None;
            }
            Some(job)
        }
    }

    pub fn assign(job: JobHandle, child: &Child) -> bool {
        unsafe {
            let handle = child.as_raw_handle() as *mut winapi::ctypes::c_void;
            AssignProcessToJobObject(job, handle) != 0
        }
    }

    pub fn terminate(job: JobHandle) {
        unsafe {
            TerminateJobObject(job, 0);
        }
    }
}

// ------------------------------------------------------------------
// Shared state
// ------------------------------------------------------------------
#[cfg(windows)]
struct JobHandle(job::JobHandle);
#[cfg(windows)]
unsafe impl Send for JobHandle {}
#[cfg(windows)]
unsafe impl Sync for JobHandle {}

struct BackendProcess {
    child: Child,
    #[cfg(windows)]
    job: Option<JobHandle>,
}

/// Terminate the Python backend with multiple fallback layers.
fn kill_backend(proc_opt: &mut Option<BackendProcess>) {
    if let Some(mut proc) = proc_opt.take() {
        #[cfg(windows)]
        {
            // Layer 1: TerminateJobObject kills the entire job tree
            if let Some(job) = proc.job.take() {
                job::terminate(job.0);
            }

            // Layer 2: taskkill /T /F /PID <pid> — force-kill process tree
            // This catches anything that escaped the job object (e.g. uvicorn
            // reload supervisor spawned before assignment).
            let pid = proc.child.id();
            let _ = Command::new("taskkill")
                .args(&["/T", "/F", "/PID", &pid.to_string()])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }

        // Layer 3 (fallback / non-Windows): direct child kill
        let _ = proc.child.kill();
        let _ = proc.child.wait();
    }
}

// ------------------------------------------------------------------
fn main() {
    let backend: Arc<Mutex<Option<BackendProcess>>> = Arc::new(Mutex::new(None));
    let backend_setup = Arc::clone(&backend);

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(move |_app| {
            let python_cmd = if cfg!(target_os = "windows") {
                "python"
            } else {
                "python3"
            };

            // Resolve backend directory: src-tauri/ -> ../../backend
            let manifest_dir = env!("CARGO_MANIFEST_DIR");
            let backend_dir = Path::new(manifest_dir)
                .join("../../backend")
                .canonicalize()
                .unwrap_or_else(|_| Path::new(manifest_dir).join("../../backend"));

            // Launch uvicorn directly with --no-reload to avoid the
            // supervisor + worker subprocess tree that reload mode creates.
            // A single-process uvicorn stays inside the job object reliably.
            let mut cmd = Command::new(python_cmd);
            cmd.arg("-m").arg("uvicorn")
                .arg("app.main:app")
                .arg("--host").arg("127.0.0.1")
                .arg("--port").arg("8848")
                .arg("--no-reload")
                .current_dir(&backend_dir)
                .stdout(Stdio::null())
                .stderr(Stdio::null());

            #[cfg(windows)]
            let job = job::create();

            #[cfg(windows)]
            if job.is_some() {
                const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;
                cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);
            }

            match cmd.spawn() {
                Ok(child) => {
                    #[cfg(windows)]
                    {
                        if let Some(job) = job {
                            if job::assign(job, &child) {
                                *backend_setup.lock().unwrap() = Some(BackendProcess {
                                    child,
                                    job: Some(JobHandle(job)),
                                });
                            } else {
                                eprintln!("[WARN] Failed to assign Python process to job object");
                                *backend_setup.lock().unwrap() = Some(BackendProcess {
                                    child,
                                    job: None,
                                });
                            }
                        } else {
                            *backend_setup.lock().unwrap() = Some(BackendProcess {
                                child,
                                job: None,
                            });
                        }
                    }
                    #[cfg(not(windows))]
                    {
                        *backend_setup.lock().unwrap() = Some(BackendProcess { child });
                    }
                }
                Err(e) => {
                    eprintln!(
                        "[ERROR] Failed to spawn Python backend from {}: {}",
                        backend_dir.display(),
                        e
                    );
                }
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Cleanup on window close OR app exit (covers taskbar close, Alt+F4,
    // Ctrl+C in terminal, and normal window X button).
    let backend_cleanup = Arc::clone(&backend);
    app.run(move |_app_handle, event| {
        match event {
            // Window close button / taskbar right-click close
            tauri::RunEvent::WindowEvent { label, event: win_event, .. } => {
                if label == "main" {
                    if let tauri::WindowEvent::CloseRequested { .. } = win_event {
                        kill_backend(&mut *backend_cleanup.lock().unwrap());
                    }
                }
            }
            // Application exit (graceful shutdown path)
            tauri::RunEvent::ExitRequested { .. } => {
                kill_backend(&mut *backend_cleanup.lock().unwrap());
            }
            _ => {}
        }
    });
}
