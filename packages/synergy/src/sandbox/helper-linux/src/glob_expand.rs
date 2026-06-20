use crate::error::HelperError;
use std::collections::HashSet;
use std::path::Path;

#[cfg(test)]
use std::path::PathBuf;
const MAX_MATCHES: usize = 8192;

/// Returns true when a pattern contains glob wildcard metacharacters.
fn has_wildcard(pattern: &str) -> bool {
    pattern.contains('*') || pattern.contains('?') || pattern.contains('[') || pattern.contains('{')
}

/// Expand glob patterns into concrete canonical paths.
///
/// * Absolute patterns are expanded directly.
/// * Relative patterns are resolved against `root_dir` before expansion.
/// * Literal paths (no wildcards) are canonicalized but still returned even
///   when the path does not exist (so tmpfs mounts can be placed preemptively).
/// * Wildcard patterns use the `glob` crate and entry-level canonicalize.
/// * Symlinks are followed and results are deduplicated.
/// * If the total number of matches exceeds `MAX_MATCHES` (8192) or a
///   per-pattern error occurs, an error is returned with the failing pattern.
pub fn expand_glob_patterns(
    patterns: &[String],
    root_dir: &Path,
) -> Result<Vec<String>, HelperError> {
    let mut all_matches: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    for pattern in patterns {
        let glob_pattern = if pattern.starts_with('/') {
            pattern.clone()
        } else {
            root_dir.join(pattern).to_string_lossy().into_owned()
        };

        // Literal paths — no wildcard characters.
        if !has_wildcard(&glob_pattern) {
            let resolved = canonicalize_or_keep(&glob_pattern);
            if seen.insert(resolved.clone()) {
                all_matches.push(resolved);
            }
            continue;
        }

        // Wildcard expansion.
        let entries = match glob::glob(&glob_pattern) {
            Ok(entries) => entries,
            Err(e) => {
                return Err(HelperError::Bwrap(format!(
                    "glob pattern '{pattern}' is invalid: {e}",
                )));
            }
        };

        for entry in entries {
            let path = match entry {
                Ok(p) => p,
                Err(e) => {
                    return Err(HelperError::Bwrap(format!(
                        "failed to read entry for glob pattern '{pattern}': {e}",
                    )));
                }
            };

            // Follow symlinks, skip broken ones.
            let canonical = match path.canonicalize() {
                Ok(c) => c,
                Err(_) => continue,
            };

            let canonical_str = canonical.to_string_lossy().into_owned();
            if seen.insert(canonical_str.clone()) {
                all_matches.push(canonical_str);

                if all_matches.len() > MAX_MATCHES {
                    return Err(HelperError::Bwrap(format!(
                        "glob expansion exceeded maximum of {MAX_MATCHES} matches \
                         (pattern: '{pattern}')",
                    )));
                }
            }
        }
    }

    Ok(all_matches)
}

/// Canonicalize the path if it exists, otherwise return the original string.
fn canonicalize_or_keep(raw: &str) -> String {
    Path::new(raw)
        .canonicalize()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix;

    fn tmp_root() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("synergy-glob-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(root: &Path, rel: &str) {
        let p = root.join(rel);
        if let Some(parent) = p.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(&p, b"").unwrap();
    }

    // --- literal path tests ---

    #[test]
    fn literal_absolute_existing_path() {
        let root = tmp_root();
        touch(&root, "a.txt");
        let patterns = vec![root.join("a.txt").to_string_lossy().into_owned()];
        let expanded = expand_glob_patterns(&patterns, &root).unwrap();
        assert_eq!(expanded.len(), 1);
        assert!(expanded[0].ends_with("a.txt"));
    }

    #[test]
    fn literal_absolute_nonexistent_path() {
        let root = tmp_root();
        let p = root.join("ghost.bin").to_string_lossy().into_owned();
        let patterns = vec![p.clone()];
        let expanded = expand_glob_patterns(&patterns, &root).unwrap();
        assert_eq!(expanded, vec![p]);
    }

    #[test]
    fn literal_relative_resolves_against_root() {
        let root = tmp_root();
        touch(&root, "sub/file.txt");
        let patterns = vec!["sub/file.txt".to_string()];
        let expanded = expand_glob_patterns(&patterns, &root).unwrap();
        assert_eq!(expanded.len(), 1);
        assert!(expanded[0].ends_with("sub/file.txt"));
    }

    // --- wildcard expansion tests ---

    #[test]
    fn wildcard_single_star() {
        let root = tmp_root();
        touch(&root, "logs/a.log");
        touch(&root, "logs/b.log");
        touch(&root, "logs/c.txt");

        let pattern = root.join("logs/*.log").to_string_lossy().into_owned();
        let expanded = expand_glob_patterns(&[pattern], &root).unwrap();
        assert_eq!(expanded.len(), 2);
        assert!(expanded.iter().any(|p| p.ends_with("a.log")));
        assert!(expanded.iter().any(|p| p.ends_with("b.log")));
    }

    #[test]
    fn wildcard_double_star() {
        let root = tmp_root();
        touch(&root, "deep/a/1.txt");
        touch(&root, "deep/b/2.txt");
        touch(&root, "shallow/3.txt");

        let pattern = root.join("deep/**/*.txt").to_string_lossy().into_owned();
        let expanded = expand_glob_patterns(&[pattern], &root).unwrap();
        assert_eq!(expanded.len(), 2);
    }

    #[test]
    fn wildcard_no_match() {
        let root = tmp_root();
        let pattern = root.join("empty_dir/*.xyz").to_string_lossy().into_owned();
        let expanded = expand_glob_patterns(&[pattern], &root).unwrap();
        assert!(expanded.is_empty());
    }

    // --- deduplication ---

    #[test]
    fn deduplicates_identical_paths() {
        let root = tmp_root();
        touch(&root, "dup/a.txt");
        let p = root.join("dup/a.txt").to_string_lossy().into_owned();
        let patterns = vec![p.clone(), p.clone()];
        let expanded = expand_glob_patterns(&patterns, &root).unwrap();
        assert_eq!(expanded.len(), 1);
    }

    // --- max match limit ---

    #[test]
    fn max_match_limit_exceeded() {
        let root = tmp_root();
        for i in 0..(MAX_MATCHES + 2) {
            touch(&root, &format!("flood/{i:05}.txt"));
        }
        let pattern = root.join("flood/*.txt").to_string_lossy().into_owned();
        let err = expand_glob_patterns(&[pattern], &root).unwrap_err();
        assert!(
            err.to_string().contains("exceeded maximum"),
            "expected max-match-limit error, got: {err}"
        );
    }

    // --- symlink handling ---

    #[test]
    fn follows_symlinks_canonicalizes_target() {
        let root = tmp_root();
        touch(&root, "real/file.txt");
        let real = root.join("real/file.txt");
        let link = root.join("link.txt");

        // Only run symlink test on platforms that support it (Unix).
        #[cfg(unix)]
        {
            unix::fs::symlink(&real, &link).unwrap();
            let pattern = root.join("*.txt").to_string_lossy().into_owned();
            let expanded = expand_glob_patterns(&[pattern], &root).unwrap();

            // The symlink target should be canonicalized to real/file.txt.
            // The glob itself will also match real/file.txt directly, but that's
            // fine — we just need to confirm the symlink's canonical path is
            // present.
            assert!(
                expanded.iter().any(|p| p.ends_with("real/file.txt")),
                "symlink should be canonicalized to real target"
            );
        }
    }

    #[test]
    fn skips_broken_symlink() {
        let root = tmp_root();
        let broken_link = root.join("broken.txt");

        #[cfg(unix)]
        {
            unix::fs::symlink("/nonexistent/path", &broken_link).unwrap();
            let pattern = root.join("broken.*").to_string_lossy().into_owned();
            let expanded = expand_glob_patterns(&[pattern], &root).unwrap();
            // Broken symlink: canonicalize fails, entry is skipped.
            assert!(
                expanded.is_empty(),
                "broken symlinks should be skipped, got {expanded:?}"
            );
        }
    }

    // --- error reporting ---

    #[test]
    fn invalid_pattern_reports_which_pattern() {
        let err = expand_glob_patterns(&["[unclosed".to_string()], Path::new("/")).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("[unclosed"),
            "error should name the failing pattern, got: {msg}"
        );
    }

    #[test]
    fn max_match_error_reports_pattern() {
        let root = tmp_root();
        for i in 0..(MAX_MATCHES + 2) {
            touch(&root, &format!("flood/{i:05}.txt"));
        }
        let pattern = root.join("flood/*.txt").to_string_lossy().into_owned();
        let err = expand_glob_patterns(&[pattern.clone()], &root).unwrap_err();
        assert!(
            err.to_string().contains("flood/*.txt"),
            "error should name the failing pattern, got: {err}"
        );
    }
}
