#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use tauri::Manager;

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

struct BackendState {
    url: Mutex<String>,
    child: Mutex<Option<BackendProcess>>,
}

impl Default for BackendState {
    fn default() -> Self {
        Self {
            url: Mutex::new("http://127.0.0.1:8848".to_string()),
            child: Mutex::new(None),
        }
    }
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
// Tauri command: expose backend URL to the frontend
// ------------------------------------------------------------------
#[tauri::command]
fn backend_url(state: tauri::State<BackendState>) -> String {
    state.url.lock().unwrap().clone()
}

/// Poll the backend health endpoint until it responds or the timeout expires.
async fn wait_for_backend(url: &str, timeout_secs: u64) -> Result<(), String> {
    let client = reqwest::Client::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);

    while std::time::Instant::now() < deadline {
        match client
            .get(format!("{}/api/v1/system/health", url))
            .timeout(std::time::Duration::from_secs(2))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => return Ok(()),
            _ => tokio::time::sleep(std::time::Duration::from_millis(500)).await,
        }
    }
    Err(format!("backend did not start within {} seconds", timeout_secs))
}

/// Find an available TCP port starting from `start`.
fn find_available_port(start: u16, max_attempts: u16) -> Result<u16, String> {
    for port in start..start + max_attempts {
        match std::net::TcpStream::connect(("127.0.0.1", port)) {
            Ok(_) => continue,      // port is in use, try next
            Err(_) => return Ok(port), // connection refused → port is free
        }
    }
    Err(format!(
        "no available port found between {} and {}",
        start,
        start + max_attempts - 1
    ))
}

/// Launch the embedded Python backend shipped with the Tauri bundle.
/// Falls back to system python/python3 when running in development mode.
fn start_backend(
    app: &mut tauri::App,
    port: u16,
) -> Result<Child, Box<dyn std::error::Error>> {
    let resource_dir = app.path().resource_dir()?;
    let local_dir = app.path().app_local_data_dir()?;
    std::fs::create_dir_all(&local_dir)?;

    // Prefer the embedded Python runtime bundled with the app.
    let embedded_python = resource_dir.join("runtime").join("python").join("python.exe");
    let embedded_backend = resource_dir.join("backend").join("run.py");

    let (python, backend_dir, backend_script): (std::path::PathBuf, std::path::PathBuf, Vec<String>) =
        if embedded_python.exists() && embedded_backend.exists() {
            eprintln!(
                "[INFO] Using embedded Python runtime: {}",
                embedded_python.display()
            );
            let backend_dir = resource_dir.join("backend");
            (
                embedded_python.clone(),
                backend_dir.clone(),
                vec![
                    "-m".to_string(),
                    "uvicorn".to_string(),
                    "app.main:app".to_string(),
                    "--host".to_string(),
                    "127.0.0.1".to_string(),
                    "--port".to_string(),
                    port.to_string(),
                ],
            )
        } else {
            // Development fallback: use system Python from the repository backend/.
            eprintln!("[INFO] Embedded runtime not found, falling back to system Python (dev mode).");
            let manifest_dir = env!("CARGO_MANIFEST_DIR");
            let backend_dir = Path::new(manifest_dir)
                .join("../../backend")
                .canonicalize()
                .unwrap_or_else(|_| Path::new(manifest_dir).join("../../backend"));

            let python_cmd = if cfg!(target_os = "windows") {
                "python"
            } else {
                "python3"
            };

            (
                std::path::PathBuf::from(python_cmd),
                backend_dir,
                vec![
                    "-m".to_string(),
                    "uvicorn".to_string(),
                    "app.main:app".to_string(),
                    "--host".to_string(),
                    "127.0.0.1".to_string(),
                    "--port".to_string(),
                    port.to_string(),
                ],
            )
        };

    // Open backend log in %LOCALAPPDATA%\com.cloudmind-zome.app\backend.log
    let log_path = local_dir.join("backend.log");
    let log_file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)?;
    let log_file_err = log_file.try_clone()?;

    let mut cmd = Command::new(&python);
    for arg in &backend_script {
        cmd.arg(arg);
    }

    cmd.current_dir(&backend_dir)
        .env("PYTHONPATH", &backend_dir)
        .env("CLOUDMIND_DATA_DIR", &local_dir)
        .stdout(Stdio::from(log_file))
        .stderr(Stdio::from(log_file_err));

    #[cfg(windows)]
    let job = job::create();

    #[cfg(windows)]
    if job.is_some() {
        const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x01000000;
        cmd.creation_flags(CREATE_BREAKAWAY_FROM_JOB);
    }

    let mut child = cmd.spawn().map_err(|e| {
        eprintln!(
            "[ERROR] Failed to spawn Python backend from {}: {}",
            backend_dir.display(),
            e
        );
        e
    })?;

    #[cfg(windows)]
    {
        if let Some(job) = job {
            if !job::assign(job, &child) {
                eprintln!("[WARN] Failed to assign Python process to job object");
            }
        }
    }

    if let Some(status) = child.try_wait()? {
        return Err(format!("Backend exited immediately with status: {}", status).into());
    }

    eprintln!(
        "[INFO] Backend started on port {}. Logs: {}",
        port,
        log_path.display()
    );
    Ok(child)
}

// ------------------------------------------------------------------
fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(BackendState::default())
        .invoke_handler(tauri::generate_handler![backend_url])
        .setup(move |app| {
            // Pick an available port and store the resulting backend URL.
            let port = find_available_port(8848, 100).unwrap_or_else(|e| {
                eprintln!("[WARN] Port detection failed: {}. Falling back to 8848.", e);
                8848
            });
            let url = format!("http://127.0.0.1:{}", port);
            std::env::set_var("CLOUDMIND_BACKEND_URL", &url);
            eprintln!("[INFO] Backend URL set to {}", url);

            match start_backend(app, port) {
                Ok(child) => {
                    let state = app.state::<BackendState>();
                    *state.url.lock().unwrap() = url.clone();
                    #[cfg(windows)]
                    {
                        *state.child.lock().unwrap() = Some(BackendProcess {
                            child,
                            job: None,
                        });
                    }
                    #[cfg(not(windows))]
                    {
                        *state.child.lock().unwrap() = Some(BackendProcess { child });
                    }

                    // Wait for the backend health endpoint before letting the UI load.
                    let url_for_wait = url.clone();
                    if let Err(e) = tauri::async_runtime::block_on(wait_for_backend(
                        &url_for_wait,
                        30,
                    )) {
                        eprintln!("[ERROR] Backend failed to start: {}", e);
                    }
                }
                Err(e) => {
                    let state = app.state::<BackendState>();
                    *state.url.lock().unwrap() = url.clone();
                    eprintln!("[ERROR] Backend startup failed: {}", e);
                    // Continue launching the app so the user can see the error UI if desired.
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // Cleanup on window close OR app exit.
    app.run(move |app_handle, event| {
        match event {
            tauri::RunEvent::WindowEvent { label, event: win_event, .. } => {
                if label == "main" {
                    if let tauri::WindowEvent::CloseRequested { .. } = win_event {
                        kill_backend(&mut *app_handle.state::<BackendState>().child.lock().unwrap());
                    }
                }
            }
            tauri::RunEvent::ExitRequested { .. } => {
                kill_backend(&mut *app_handle.state::<BackendState>().child.lock().unwrap());
            }
            _ => {}
        }
    });
}
