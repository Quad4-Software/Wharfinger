package collect

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// tempMetrics reads hwmon sysfs: /sys/class/hwmon/hwmonN/tempM_input
// with matching tempM_label or the chip name as the label. Sensors
// above 150C or at/below 0 are almost certainly broken; drop them.
func tempMetrics() []Temp {
	hwmons, err := filepath.Glob(sysFile("class/hwmon/hwmon*"))
	if err != nil {
		return nil
	}
	var out []Temp
	for _, h := range hwmons {
		chip, _ := readTrim(h + "/name")
		inputs, _ := filepath.Glob(h + "/temp*_input")
		for _, in := range inputs {
			v, err := strconv.ParseFloat(readTrimMust(in), 64)
			if err != nil {
				continue
			}
			c := v / 1000
			if c <= 0 || c > 150 {
				continue
			}
			label := chip
			base := strings.TrimSuffix(in, "_input")
			if l := readTrimMust(base + "_label"); l != "" {
				label = chip + " " + l
			}
			out = append(out, Temp{Label: label, Celsius: round1(c)})
		}
	}
	// Fallback: thermal zones for platforms without hwmon entries.
	if len(out) == 0 {
		zones, _ := filepath.Glob(sysFile("class/thermal/thermal_zone*"))
		for _, z := range zones {
			v, err := strconv.ParseFloat(readTrimMust(z+"/temp"), 64)
			if err != nil {
				continue
			}
			c := v / 1000
			if c <= 0 || c > 150 {
				continue
			}
			label := readTrimMust(z + "/type")
			out = append(out, Temp{Label: label, Celsius: round1(c)})
		}
	}
	return out
}

func readTrimMust(p string) string {
	b, err := os.ReadFile(p)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readTrim(p string) (string, error) {
	b, err := os.ReadFile(p)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}
