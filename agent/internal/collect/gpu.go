package collect

import (
	"encoding/csv"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

func gpuMetrics() []GPU {
	var out []GPU
	out = append(out, nvidiaGPUs()...)
	out = append(out, drmGPUs()...)
	return out
}

// nvidiaGPUs shells out to nvidia-smi, which covers every supported
// card and driver version. Missing binary means no NVIDIA hardware.
func nvidiaGPUs() []GPU {
	out, err := runCmd(5*time.Second, "nvidia-smi",
		"--query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total,power.draw",
		"--format=csv,noheader,nounits")
	if err != nil {
		return nil
	}
	var gpus []GPU
	r := csv.NewReader(strings.NewReader(string(out)))
	rows, err := r.ReadAll()
	if err != nil {
		return nil
	}
	for _, row := range rows {
		if len(row) < 6 {
			continue
		}
		temp, _ := strconv.ParseFloat(strings.TrimSpace(row[1]), 64)
		util, _ := strconv.ParseFloat(strings.TrimSpace(row[2]), 64)
		mu, _ := strconv.ParseUint(strings.TrimSpace(row[3]), 10, 64)
		mt, _ := strconv.ParseUint(strings.TrimSpace(row[4]), 10, 64)
		pw, _ := strconv.ParseFloat(strings.TrimSpace(row[5]), 64)
		gpus = append(gpus, GPU{
			Vendor:   "nvidia",
			Name:     strings.TrimSpace(row[0]),
			TempC:    temp,
			UtilPct:  round1(util),
			MemUsed:  mu * 1024 * 1024,
			MemTotal: mt * 1024 * 1024,
			PowerW:   round1(pw),
		})
	}
	return gpus
}

// drmGPUs covers AMD and Intel through sysfs, no vendor tools needed.
// AMD exposes gpu_busy_percent and hwmon temps/power; Intel exposes
// gt_cur_freq and hwmon temps. Cards already handled by nvidia-smi are
// skipped by vendor id.
func drmGPUs() []GPU {
	cards, err := filepath.Glob(sysFile("class/drm/card[0-9]"))
	if err != nil {
		return nil
	}
	var out []GPU
	for _, card := range cards {
		vendor := readTrimMust(card + "/device/vendor")
		var v string
		switch vendor {
		case "0x1002", "0x1022":
			v = "amd"
		case "0x8086":
			v = "intel"
		case "0x10de":
			continue // nvidia handled via nvidia-smi
		default:
			continue
		}
		g := GPU{Vendor: v, Name: drmCardName(card, v)}
		if util := readTrimMust(card + "/device/gpu_busy_percent"); util != "" {
			if f, err := strconv.ParseFloat(util, 64); err == nil {
				g.UtilPct = round1(f)
			}
		}
		// hwmon under the device carries temp/power on AMD and some Intel.
		hws, _ := filepath.Glob(card + "/device/hwmon/hwmon*")
		for _, h := range hws {
			if t := readTrimMust(h + "/temp1_input"); t != "" {
				if f, err := strconv.ParseFloat(t, 64); err == nil {
					g.TempC = round1(f / 1000)
				}
			}
			if p := readTrimMust(h + "/power1_average"); p != "" {
				if f, err := strconv.ParseFloat(p, 64); err == nil {
					g.PowerW = round1(f / 1_000_000)
				}
			}
		}
		// vram totals live in mem_info_vram_* on amdgpu.
		if v == "amd" {
			if mt := readTrimMust(card + "/device/mem_info_vram_total"); mt != "" {
				if n, err := strconv.ParseUint(mt, 10, 64); err == nil {
					g.MemTotal = n
				}
			}
			if mu := readTrimMust(card + "/device/mem_info_vram_used"); mu != "" {
				if n, err := strconv.ParseUint(mu, 10, 64); err == nil {
					g.MemUsed = n
				}
			}
		}
		out = append(out, g)
	}
	return out
}

// drmCardName picks a readable model when the driver exports one,
// else falls back to a vendor label.
func drmCardName(card, vendor string) string {
	if n := readTrimMust(card + "/device/product_name"); n != "" {
		return n
	}
	return vendor + " gpu"
}
