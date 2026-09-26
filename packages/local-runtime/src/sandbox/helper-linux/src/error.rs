use std::fmt;

/// Unified error type for the Linux sandbox helper.
///
/// Each variant maps to a distinct failure domain (config, bwrap, seccomp, proxy, landlock, I/O).
/// Upcoming implementation phases will wire these into actual enforcement paths.
#[derive(Debug)]
pub enum HelperError {
    /// Configuration loading or JSON parsing failure.
    Config(String),
    /// Bubblewrap argument construction or invocation failure.
    Bwrap(String),
    /// Seccomp filter construction or application failure.
    Seccomp(String),
    /// Proxy plan construction failure.
    Proxy(String),
    /// Landlock ruleset construction or application failure.
    Landlock(String),
    /// General I/O or system error.
    Io(std::io::Error),
}

impl fmt::Display for HelperError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Config(msg) => write!(f, "config error: {msg}"),
            Self::Bwrap(msg) => write!(f, "bwrap error: {msg}"),
            Self::Seccomp(msg) => write!(f, "seccomp error: {msg}"),
            Self::Proxy(msg) => write!(f, "proxy error: {msg}"),
            Self::Landlock(msg) => write!(f, "landlock error: {msg}"),
            Self::Io(err) => write!(f, "I/O error: {err}"),
        }
    }
}

impl std::error::Error for HelperError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Io(err) => Some(err),
            _ => None,
        }
    }
}

impl From<std::io::Error> for HelperError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(err)
    }
}
