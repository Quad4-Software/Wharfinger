package edge

import (
	"fmt"
	"mime"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
)

// secureJoin resolves rel under root and refuses anything that
// escapes: absolute paths, tilde, and .. segments. The returned path
// is always a descendant of root.
func secureJoin(root, rel string) (string, error) {
	if rel == "" || rel == "." {
		return root, nil
	}
	if filepath.IsAbs(rel) || strings.HasPrefix(rel, "~") || strings.ContainsAny(rel, "\x00") {
		return "", fmt.Errorf("unsafe path %q", rel)
	}
	cleaned := filepath.Clean(filepath.FromSlash(rel))
	if cleaned == ".." || strings.HasPrefix(cleaned, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes root")
	}
	full := filepath.Join(root, cleaned)
	back, err := filepath.Rel(root, full)
	if err != nil || back == ".." || strings.HasPrefix(back, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("path escapes root")
	}
	return full, nil
}

// hashedAssetRe matches fingerprinted bundle names like
// app-3f2a1b9c.js or index.B1a2C3d4.css; those get immutable caching.
var hashedAssetRe = regexp.MustCompile(`[.-][0-9a-fA-F]{8,}(\.|$)`)

func isImmutableAsset(urlPath string) bool {
	if strings.Contains(urlPath, "/assets/") {
		return true
	}
	return hashedAssetRe.MatchString(path.Base(urlPath))
}

// serveStatic serves files for a staticRoot route. staticRoot is a
// hub-declared path relative to the agent state dir (validated at
// table intake); the request path is then resolved under it with the
// same traversal rules. index.html is the directory fallback.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request, rt *Route) {
	root, err := secureJoin(s.cfg.StateDir, rt.StaticRoot)
	if err != nil {
		http.Error(w, "bad static root", http.StatusInternalServerError)
		return
	}
	// URL paths always start with /; the path is root-relative here,
	// not a filesystem absolute path.
	full, err := secureJoin(root, strings.TrimPrefix(r.URL.Path, "/"))
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	st, err := os.Stat(full)
	if err == nil && st.IsDir() {
		full = filepath.Join(full, "index.html")
		st, err = os.Stat(full)
	}
	if err != nil || st.IsDir() {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	f, err := os.Open(full)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	defer f.Close()

	// Weak etag on size+mtime: enough for conditional revalidation
	// without hashing every response.
	etag := fmt.Sprintf(`W/"%x-%x"`, st.Size(), st.ModTime().UnixNano())
	if inm := r.Header.Get("If-None-Match"); inm == etag {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", etag)
	if isImmutableAsset(r.URL.Path) {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		w.Header().Set("Cache-Control", "no-cache")
	}

	ctype := mime.TypeByExtension(filepath.Ext(full))
	if ctype == "" {
		var head [512]byte
		n, _ := f.Read(head[:])
		ctype = http.DetectContentType(head[:n])
		if _, err := f.Seek(0, 0); err != nil {
			http.Error(w, "read error", http.StatusInternalServerError)
			return
		}
	}
	w.Header().Set("Content-Type", ctype)
	http.ServeContent(w, r, st.Name(), st.ModTime(), f)
}
