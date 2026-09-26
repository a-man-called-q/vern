use std::net::SocketAddr;

use thiserror::Error;
use tracing_subscriber::EnvFilter;

mod app;
mod auth;
mod config;

#[derive(Debug, Error)]
enum StartupError {
    #[error(transparent)]
    Config(#[from] config::ConfigError),
    #[error("invalid bind address: {0}")]
    BindAddress(#[from] std::net::AddrParseError),
    #[error("failed to bind API listener: {0}")]
    Bind(#[from] std::io::Error),
}

#[tokio::main]
async fn main() -> Result<(), StartupError> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let config = config::Config::from_env()?;
    let host = std::env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = std::env::var("PORT").unwrap_or_else(|_| "3001".to_owned());
    let bind_address: SocketAddr = format!("{host}:{port}").parse()?;
    let app = app::router(auth::AppState::from_config(config));
    let listener = tokio::net::TcpListener::bind(bind_address).await?;
    tracing::info!(address = %listener.local_addr()?, "API server listening");
    axum::serve(listener, app).await.map_err(StartupError::Bind)
}
