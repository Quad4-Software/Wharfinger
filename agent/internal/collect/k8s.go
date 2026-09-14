package collect

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Kubernetes node view comes from the local kubelet. The legacy
// read-only port 10255 is tried first; the authenticated port 10250
// needs a bearer token from WHARFINGER_KUBE_TOKEN or
// WHARFINGER_KUBE_TOKEN_FILE (the in-cluster service account path is the
// default file). Node-local kubelet certs are cluster-signed and do
// not match 127.0.0.1, so port 10250 fails closed: without a CA pinned
// by WHARFINGER_KUBE_CA_FILE collection is skipped entirely unless
// WHARFINGER_KUBE_INSECURE (or the -kube-insecure flag) explicitly opts
// out of verification.
const (
	kubeletReadOnly = "http://127.0.0.1:10255"
	kubeletSecure   = "https://127.0.0.1:10250"
)

func kubeletToken() string {
	if t := os.Getenv("WHARFINGER_KUBE_TOKEN"); t != "" {
		return t
	}
	f := os.Getenv("WHARFINGER_KUBE_TOKEN_FILE")
	if f == "" {
		f = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	}
	if b, err := os.ReadFile(f); err == nil {
		return strings.TrimSpace(string(b))
	}
	return ""
}

// KubeInsecure mirrors the -kube-insecure flag so the collector can
// honor it without taking a config dependency. WHARFINGER_KUBE_INSECURE
// works identically and needs no plumbing.
var KubeInsecure bool

func kubeInsecureAllowed() bool {
	if KubeInsecure {
		return true
	}
	v := os.Getenv("WHARFINGER_KUBE_INSECURE")
	return v == "1" || strings.EqualFold(v, "true") || strings.EqualFold(v, "on")
}

// kubeletSecureClient builds the client for port 10250, or nil when
// collection must be skipped. A pinned CA always wins; without one the
// port is only used when the operator explicitly opted into insecure
// TLS, because silently disabling verification would hide a local
// impersonator on a node port every pod can reach.
func kubeletSecureClient() *http.Client {
	if caFile := os.Getenv("WHARFINGER_KUBE_CA_FILE"); caFile != "" {
		if pem, err := os.ReadFile(caFile); err == nil {
			pool := x509.NewCertPool()
			if pool.AppendCertsFromPEM(pem) {
				return &http.Client{
					Timeout: 4 * time.Second,
					Transport: &http.Transport{TLSClientConfig: &tls.Config{
						RootCAs:    pool,
						ServerName: os.Getenv("WHARFINGER_KUBE_TLS_NAME"),
					}},
				}
			}
		}
		// CA file set but unreadable or unparseable: fall through to
		// the insecure check rather than silently dropping verification.
	}
	if !kubeInsecureAllowed() {
		return nil
	}
	return &http.Client{
		Timeout: 4 * time.Second,
		// node-local kubelet serving cert cannot match 127.0.0.1
		Transport: &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: true}}, //nolint:gosec
	}
}

var kubeSkipWarn sync.Once

func kubeletSkipWarn() {
	kubeSkipWarn.Do(func() {
		log.Printf("kubernetes: skipping kubelet :10250; set WHARFINGER_KUBE_CA_FILE to pin the cluster CA or WHARFINGER_KUBE_INSECURE=1 to accept unverified TLS")
	})
}

type kubeletPodList struct {
	Items []struct {
		Metadata struct {
			Name      string `json:"name"`
			Namespace string `json:"namespace"`
		} `json:"metadata"`
		Status struct {
			Phase             string `json:"phase"`
			ContainerStatuses []struct {
				RestartCount int `json:"restartCount"`
			} `json:"containerStatuses"`
		} `json:"status"`
	} `json:"items"`
}

func kubeletGet(c *http.Client, base, token, path string, v any) error {
	req, err := http.NewRequestWithContext(context.Background(), http.MethodGet, base+path, nil)
	if err != nil {
		return err
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("kubelet api status " + res.Status)
	}
	return json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(v)
}

// k8sMetrics reports pod phases and restarts for the local node. The
// pod list is capped so a busy node cannot blow up the payload.
func k8sMetrics() *K8s {
	var list kubeletPodList
	plain := &http.Client{Timeout: 3 * time.Second}
	if err := kubeletGet(plain, kubeletReadOnly, "", "/pods", &list); err != nil {
		token := kubeletToken()
		if token == "" {
			return nil
		}
		c := kubeletSecureClient()
		if c == nil {
			kubeletSkipWarn()
			return nil
		}
		if err := kubeletGet(c, kubeletSecure, token, "/pods", &list); err != nil {
			return nil
		}
	}
	k := &K8s{}
	for _, p := range list.Items {
		k.Pods++
		restarts := 0
		for _, cs := range p.Status.ContainerStatuses {
			restarts += cs.RestartCount
		}
		k.Restarts += restarts
		switch p.Status.Phase {
		case "Running":
			k.Running++
		case "Pending":
			k.Pending++
		case "Failed":
			k.Failed++
		case "Succeeded":
			k.Succeeded++
		}
		if len(k.PodList) < 200 {
			k.PodList = append(k.PodList, K8sPod{
				Name:      p.Metadata.Name,
				Namespace: p.Metadata.Namespace,
				Phase:     p.Status.Phase,
				Restarts:  restarts,
			})
		}
	}
	return k
}
