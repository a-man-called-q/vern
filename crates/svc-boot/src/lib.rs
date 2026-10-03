//! How every API starts and stops, whatever it serves:
//!
//! - `init`: the `.env` of development, and the log.
//! - `serve`: the listener on `HOST` and `PORT`, and a shutdown that finishes the
//!   requests in flight.

use std::{env, net::SocketAddr};

use axum::Router;
use thiserror::Error;
use tracing_subscriber::EnvFilter;

#[derive(Debug, Error)]
pub enum BootError {
    #[error("PORT must be set")]
    MissingPort,
    #[error("PORT must be an integer between 1 and 65535")]
    InvalidPort,
    #[error("invalid bind address: {0}")]
    BindAddress(#[from] std::net::AddrParseError),
    #[error("failed to bind API listener: {0}")]
    Bind(#[source] std::io::Error),
    #[error("the API server stopped: {0}")]
    Serve(#[source] std::io::Error),
}

/// Call it first in `main`: loads `.env` when there is one (development; in
/// production the settings are in the environment already) and starts the log,
/// at the level `RUST_LOG` names or `info`.
pub fn init() {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();
}

/// Where the service listens: `HOST` (the loopback address when it is not set)
/// and `PORT`, which must be set.
pub fn bind_address() -> Result<SocketAddr, BootError> {
    let host = env::var("HOST").unwrap_or_else(|_| "127.0.0.1".to_owned());
    let port = env::var("PORT").map_err(|_| BootError::MissingPort)?;
    address(&host, &port)
}

fn address(host: &str, port: &str) -> Result<SocketAddr, BootError> {
    let port = port.parse::<u16>().map_err(|_| BootError::InvalidPort)?;
    if port == 0 {
        return Err(BootError::InvalidPort);
    }
    Ok(format!("{host}:{port}").parse()?)
}

/// Serves `app` on `HOST` and `PORT` until the process is told to stop, then
/// finishes the requests in flight.
pub async fn serve(app: Router) -> Result<(), BootError> {
    let listener = tokio::net::TcpListener::bind(bind_address()?)
        .await
        .map_err(BootError::Bind)?;
    let address = listener.local_addr().map_err(BootError::Bind)?;
    tracing::info!(%address, "API server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await
        .map_err(BootError::Serve)
}

/// Resolves on Ctrl-C or SIGTERM, which `docker stop` and Kubernetes send before
/// they stop the container. The server then stops accepting connections and
/// finishes the requests in flight.
async fn shutdown_signal() {
    let ctrl_c = async {
        if let Err(error) = tokio::signal::ctrl_c().await {
            tracing::error!(%error, "cannot listen for Ctrl-C");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut signal) => {
                signal.recv().await;
            }
            Err(error) => {
                tracing::error!(%error, "cannot listen for SIGTERM");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        () = ctrl_c => {},
        () = terminate => {},
    }
    tracing::info!("shutting down: finishing the requests in flight");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_address_is_the_host_and_a_port_that_can_be_listened_on() {
        assert_eq!(
            address("0.0.0.0", "4001").expect("valid").to_string(),
            "0.0.0.0:4001"
        );
        for port in ["0", "65536", "-1", "http", ""] {
            assert!(
                matches!(address("127.0.0.1", port), Err(BootError::InvalidPort)),
                "{port:?}"
            );
        }
        assert!(matches!(
            address("not a host", "4001"),
            Err(BootError::BindAddress(_))
        ));
    }
}
