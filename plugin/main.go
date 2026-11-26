// Master Music Manager plugin for Navidrome.
//
//   - Scrobbler: every now-playing and every play goes to Master Music
//     Manager the moment Navidrome records it, from every client.
//   - History: Navidrome's own scrobble history (with times) is copied once,
//     then every 30 minutes (ScrobbleRetriever + Scheduler), so nothing is
//     missed while Master Music Manager is offline.
//   - Metadata agent: artist texts written in Master Music Manager show up
//     in Navidrome too.
package main

import (
	"encoding/json"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/navidrome/navidrome/plugins/pdk/go/host"
	"github.com/navidrome/navidrome/plugins/pdk/go/lifecycle"
	"github.com/navidrome/navidrome/plugins/pdk/go/metadata"
	"github.com/navidrome/navidrome/plugins/pdk/go/pdk"
	"github.com/navidrome/navidrome/plugins/pdk/go/scheduler"
	"github.com/navidrome/navidrome/plugins/pdk/go/scrobbler"
)

const version = "1.0.0"

type plugin struct{}

func init() {
	p := &plugin{}
	scrobbler.Register(p)
	lifecycle.Register(p)
	scheduler.Register(p)
	metadata.Register(p)
}

func main() {}

// ---- config + calls ----

func cfg(key string) string {
	v, _ := pdk.GetConfig(key)
	return strings.TrimSpace(v)
}

func enabled(key string) bool {
	v := strings.ToLower(cfg(key))
	return v == "" || v == "true" || v == "1" || v == "yes"
}

func call(method, path string, body any) (*host.HTTPResponse, error) {
	base := strings.TrimRight(cfg("url"), "/")
	if base == "" {
		return nil, fmt.Errorf("the Master Music Manager address is not set")
	}
	var data []byte
	if body != nil {
		var err error
		if data, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	resp, err := host.HTTPSend(host.HTTPRequest{
		Method: method,
		URL:    base + path,
		Headers: map[string]string{
			"Authorization":  "Bearer " + cfg("secret"),
			"Content-Type":   "application/json",
			"X-MMM-Plugin":   version,
		},
		Body:      data,
		TimeoutMs: 15000,
	})
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == 401 {
		return resp, fmt.Errorf("Master Music Manager refused the secret")
	}
	if resp.StatusCode >= 400 {
		return resp, fmt.Errorf("Master Music Manager answered %d", resp.StatusCode)
	}
	return resp, nil
}

func trackJSON(t scrobbler.TrackInfo) map[string]any {
	return map[string]any{
		"id": t.ID, "title": t.Title, "album": t.Album, "artist": t.Artist, "albumArtist": t.AlbumArtist,
		"duration": t.Duration, "trackNumber": t.TrackNumber, "discNumber": t.DiscNumber,
		"mbzRecordingId": t.MBZRecordingID, "path": t.Path,
	}
}

// ---- Scrobbler ----

func (p *plugin) IsAuthorized(scrobbler.IsAuthorizedRequest) (bool, error) {
	return cfg("url") != "" && cfg("secret") != "", nil
}

func (p *plugin) NowPlaying(r scrobbler.NowPlayingRequest) error {
	_, err := call("POST", "/api/plugin/playback", map[string]any{"username": r.Username, "track": trackJSON(r.Track), "state": "playing", "positionMs": int64(r.Position) * 1000})
	if err != nil {
		pdk.Log(pdk.LogWarn, "now playing: "+err.Error())
	}
	return nil // never hold Navidrome up
}

func (p *plugin) Scrobble(r scrobbler.ScrobbleRequest) error {
	_, err := call("POST", "/api/plugin/scrobble", map[string]any{"username": r.Username, "track": trackJSON(r.Track), "timestamp": r.Timestamp})
	if err != nil {
		pdk.Log(pdk.LogWarn, "scrobble: "+err.Error())
		return scrobbler.ScrobblerErrorRetryLater
	}
	return nil
}

func (p *plugin) PlaybackReport(r scrobbler.PlaybackReportRequest) error {
	_, err := call("POST", "/api/plugin/playback", map[string]any{
		"username": r.Username, "track": trackJSON(r.Track), "state": r.State, "positionMs": r.PositionMs,
		"playbackRate": r.PlaybackRate, "playerId": r.PlayerId, "playerName": r.PlayerName, "timestamp": r.Timestamp,
	})
	if err != nil {
		pdk.Log(pdk.LogDebug, "playback report: "+err.Error())
	}
	return nil
}

// ---- History ----

func (p *plugin) OnInit() error {
	if _, err := host.SchedulerScheduleRecurring("*/30 * * * *", "history", "mmm-history"); err != nil {
		pdk.Log(pdk.LogWarn, "could not schedule the history copy: "+err.Error())
	}
	// First copy shortly after start.
	_, _ = host.SchedulerScheduleOneTime(45, "history", "mmm-history-first")
	return nil
}

func (p *plugin) OnCallback(r scheduler.SchedulerCallbackRequest) error {
	if r.Payload != "history" || !enabled("syncHistory") || cfg("url") == "" {
		return nil
	}
	users, err := host.UsersGetUsers()
	if err != nil {
		return err
	}
	for _, u := range users {
		if err := syncUser(u.UserName); err != nil {
			pdk.Log(pdk.LogWarn, "history for "+u.UserName+": "+err.Error())
		}
	}
	return nil
}

type songInfo struct {
	Title, Artist, Album string
	Duration           float64
	MBID               string
}

var songCache = map[string]songInfo{}

func lookup(id, user string) songInfo {
	if s, ok := songCache[id]; ok {
		return s
	}
	raw, err := host.SubsonicAPICall("getSong?id=" + url.QueryEscape(id) + "&u=" + url.QueryEscape(user))
	s := songInfo{}
	if err == nil {
		var r struct {
			Resp struct {
				Song struct {
					Title         string  `json:"title"`
					Artist        string  `json:"artist"`
					DisplayArtist string  `json:"displayArtist"`
					Album         string  `json:"album"`
					Duration      float64 `json:"duration"`
					MusicBrainzID string  `json:"musicBrainzId"`
				} `json:"song"`
			} `json:"subsonic-response"`
		}
		if json.Unmarshal([]byte(raw), &r) == nil {
			x := r.Resp.Song
			a := x.DisplayArtist
			if a == "" {
				a = x.Artist
			}
			s = songInfo{x.Title, a, x.Album, x.Duration, x.MusicBrainzID}
		}
	}
	if len(songCache) > 20000 {
		songCache = map[string]songInfo{}
	}
	songCache[id] = s
	return s
}

func syncUser(user string) error {
	key := "last:" + user
	var from *int64
	if v, ok, _ := host.KVStoreGet(key); ok {
		if n, err := strconv.ParseInt(string(v), 10, 64); err == nil {
			n++
			from = &n
		}
	}
	opts := host.ScrobbleOptions{FromTimestamp: from, MaxItems: 1000}
	newest := int64(0)
	sent := 0
	for page := 0; page < 200; page++ {
		refs, next, err := host.ScrobbleRetrieverGetScrobbles(user, opts)
		if err != nil {
			return err
		}
		items := make([]map[string]any, 0, len(refs))
		for _, s := range refs {
			info := lookup(s.MediaFileID, user)
			if info.Title == "" {
				continue
			}
			items = append(items, map[string]any{"ts": s.SubmissionTime, "title": info.Title, "artist": info.Artist, "album": info.Album, "duration": info.Duration, "mbid": info.MBID, "remoteId": s.MediaFileID})
			if s.SubmissionTime > newest {
				newest = s.SubmissionTime
			}
		}
		if len(items) > 0 {
			if _, err := call("POST", "/api/plugin/history", map[string]any{"username": user, "items": items}); err != nil {
				return err // try again next time, from the same point
			}
			sent += len(items)
			_ = host.KVStoreSet(key, []byte(strconv.FormatInt(newest, 10)))
		}
		if next == nil {
			break
		}
		opts = *next
	}
	if sent > 0 {
		pdk.Log(pdk.LogInfo, fmt.Sprintf("copied %d plays of %s", sent, user))
	}
	return nil
}

// ---- Metadata agent: artist texts ----

func (p *plugin) GetArtistBiography(r metadata.ArtistRequest) (*metadata.ArtistBiographyResponse, error) {
	if !enabled("artistInfo") || cfg("url") == "" {
		return nil, nil
	}
	resp, err := call("GET", "/api/plugin/artist?name="+url.QueryEscape(r.Name), nil)
	if err != nil {
		return nil, nil // "not found" rather than a retry storm
	}
	var out struct {
		About string `json:"about"`
	}
	if json.Unmarshal(resp.Body, &out) != nil || out.About == "" {
		return nil, nil
	}
	return &metadata.ArtistBiographyResponse{Biography: out.About}, nil
}
