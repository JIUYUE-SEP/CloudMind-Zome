use zome_sidecar::{server, supervisor};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();
    tracing::info!("zome-sidecar starting");

    supervisor::spawn_node_engine().await?;
    tokio::spawn(supervisor::watch_node_health());
    server::serve().await?;
    supervisor::shutdown().await;

    Ok(())
}
