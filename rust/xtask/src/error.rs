//! The ways a task fails before it can report a result.

use std::fmt;
use std::path::PathBuf;

/// A task could not run to completion, as opposed to running and finding problems.
#[derive(Debug)]
pub enum TaskError {
    /// A file or directory could not be read.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
    /// A file that must be JSON is not, or does not have the expected shape.
    Json { what: String, detail: String },
    /// The workspace metadata could not be read: cargo did not run, or did not succeed.
    Metadata(String),
}

impl fmt::Display for TaskError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io { path, source } => write!(formatter, "{}: {source}", path.display()),
            Self::Json { what, detail } => write!(formatter, "{what}: {detail}"),
            Self::Metadata(detail) => write!(formatter, "cargo metadata: {detail}"),
        }
    }
}

impl std::error::Error for TaskError {}
