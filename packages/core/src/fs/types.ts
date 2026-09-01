export interface DirEntry {
  readonly name: string;
  readonly kind: 'file' | 'dir' | 'symlink';
}

/**
 * A read-only, repo-sandboxed view of the filesystem.
 *
 * All paths are repo-relative and POSIX-separated; absolute paths and paths escaping
 * the repository root throw E_PATH_ESCAPE. Text reads are BOM-stripped and
 * EOL-normalized to \n, so a CRLF checkout parses to the same model as an LF one.
 * Listings are sorted by codepoint rather than returned in filesystem order — sorting
 * lives here so that determinism is a property of the boundary, not a discipline every
 * adapter author has to remember.
 *
 * There is deliberately no write method. Adapters receive this interface and return
 * Artifacts; only the pipeline's apply step writes. That is what makes `check` and
 * `sync` structurally incapable of diverging.
 */
export interface ReadOnlyFileSystem {
  readFile(relPath: string): Promise<string>;
  tryReadFile(relPath: string): Promise<string | undefined>;
  readFileRaw(relPath: string): Promise<Uint8Array>;
  exists(relPath: string): Promise<boolean>;
  listDir(relPath: string): Promise<readonly DirEntry[]>;
  /** Repo-relative POSIX paths of matching files, sorted by codepoint. */
  glob(pattern: string): Promise<readonly string[]>;
}

export interface WritableFileSystem extends ReadOnlyFileSystem {
  /** Writes UTF-8 without a BOM, creating parent directories as needed. */
  writeFile(relPath: string, contents: string): Promise<void>;
  /**
   * Copies bytes verbatim, creating parent directories as needed.
   *
   * Distinct from read-then-write because reads are BOM-stripped and EOL-normalized:
   * backing a file up through `tryReadFile` + `writeFile` would quietly convert a CRLF
   * original to LF, and a backup that does not restore the original bytes is not a
   * backup. Both paths are repo-relative, so a copy cannot escape the repository.
   */
  copyFile(fromRelPath: string, toRelPath: string): Promise<void>;
  deleteFile(relPath: string): Promise<void>;
}
