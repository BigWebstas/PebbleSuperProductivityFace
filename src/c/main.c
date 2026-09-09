// Super Productivity companion watchface.
//
// Time + date, framed by a ring that fills with today's completed / planned
// tasks, plus a bottom line that a wrist-tap cycles through today's stats (or
// shows the live-tracked task's timer when one is running). Steps, battery and
// a phone-disconnected mark sit along the top. The productivity data comes
// from this face's own trimmed SuperSync pull - see src/pkjs/index.js.

#include <pebble.h>

// message keys (match package.json + index.js)
#define KEY_MSG_TYPE          MESSAGE_KEY_MSG_TYPE
#define KEY_STATUS            MESSAGE_KEY_FACE_STATUS       // 0 ok / 1 syncing / 2 not paired / 3 error
#define KEY_DONE             MESSAGE_KEY_FACE_DONE_TODAY
#define KEY_TOTAL            MESSAGE_KEY_FACE_TOTAL_TODAY
#define KEY_WORKED_MIN       MESSAGE_KEY_FACE_WORKED_MIN
#define KEY_EST_MIN          MESSAGE_KEY_FACE_EST_REMAIN_MIN
#define KEY_NEXT_MIN         MESSAGE_KEY_FACE_NEXT_MIN      // minutes since local midnight, -1 = none
#define KEY_NEXT_TITLE       MESSAGE_KEY_FACE_NEXT_TITLE
#define KEY_HABITS_DONE      MESSAGE_KEY_FACE_HABITS_DONE
#define KEY_HABITS_TOTAL     MESSAGE_KEY_FACE_HABITS_TOTAL
#define KEY_HABIT_STREAK     MESSAGE_KEY_FACE_HABIT_STREAK
#define KEY_HABIT_TITLE      MESSAGE_KEY_FACE_HABIT_TITLE
#define KEY_WEEK_CSV         MESSAGE_KEY_FACE_WEEK_CSV      // "m0,m1,...,m6" minutes/day, [6]=today
#define KEY_TRACK_TITLE      MESSAGE_KEY_FACE_TRACKING_TITLE  // "" = not tracking
#define KEY_TRACK_ELAPSED_S  MESSAGE_KEY_FACE_TRACKING_ELAPSED_S

#define MSG_REFRESH_REQUEST 1

// persist keys
enum { PK_DONE = 1, PK_TOTAL, PK_WORKED, PK_EST, PK_NEXT_MIN, PK_NEXT_TITLE,
       PK_HAB_DONE, PK_HAB_TOTAL, PK_HAB_STREAK, PK_HAB_TITLE, PK_WEEK, PK_LAST_OK };

#define STALE_AFTER_S (60 * 60)   // grey the line once the last good sync is this old
#define LINE_MODES 5

static Window *s_window;
static Layer *s_ring_layer;
static TextLayer *s_time_layer;
static TextLayer *s_date_layer;
static Layer *s_status_layer_l;   // custom-drawn: colour + slide + marquee
static Layer *s_top_layer;        // steps / battery / bt

static int s_status = 2;
static int s_done = 0, s_total = 0;
static int s_worked_min = 0, s_est_min = 0;
static int s_next_min = -1;
static char s_next_title[40] = "";
static int s_hab_done = 0, s_hab_total = 0, s_hab_streak = 0;
static char s_hab_title[24] = "";
static int s_week[7] = {0};
static char s_track_title[40] = "";
static int s_track_elapsed_s = 0;   // as of s_track_received; the tick advances it
static time_t s_track_received = 0;
static time_t s_last_ok = 0;

static int s_line_mode = 0;
static int s_steps = 0;
static bool s_bt = true;

static char s_time_buf[8];
static char s_date_buf[24];
static char s_status_buf[96];
static char s_status_prev[96] = "";
static GColor s_status_color;

// animation state (one shared 33ms timer, self-stopping)
#define ANIM_STEP_MS 33
#define RING_STEP 55           // per-mille the shown ring moves per tick
#define PULSE_TICKS 16         // completion flash length
#define SLIDE_TICKS 7          // line cross-slide length
#define MARQUEE_STEP 2
static AppTimer *s_anim_timer = NULL;
static int s_ring_shown = 0;   // per-mille actually drawn
static int s_ring_target = 0;  // per-mille from done/total
static int s_pulse_tick = 0;   // 0 = idle
static int s_slide_tick = 0;   // 0 = idle
static int s_marquee_off = 0;  // px, status-line scroll
static bool s_marquee_on = false;

static void tick_handler(struct tm *t, TimeUnits units);
static void anim_tick(void *data);
static void render_status(void);
static void render_status_stats(void);

static void kick_anim(void) {
  if (!s_anim_timer) {
    s_anim_timer = app_timer_register(ANIM_STEP_MS, anim_tick, NULL);
  }
}

// ---------- helpers ----------
static void fmt_hm(int mins, char *out, size_t n) {
  if (mins <= 0) { snprintf(out, n, "0m"); return; }
  int h = mins / 60, m = mins % 60;
  if (h > 0) { snprintf(out, n, "%dh %02dm", h, m); }
  else { snprintf(out, n, "%dm", m); }
}

static void fmt_clock(int mins_since_midnight, char *out, size_t n) {
  int h = mins_since_midnight / 60, m = mins_since_midnight % 60;
  if (clock_is_24h_style()) {
    snprintf(out, n, "%d:%02d", h, m);
  } else {
    int h12 = h % 12; if (h12 == 0) { h12 = 12; }
    snprintf(out, n, "%d:%02d%s", h12, m, h < 12 ? "a" : "p");
  }
}

static int track_now_elapsed_s(void) {
  int e = s_track_elapsed_s + (int)(time(NULL) - s_track_received);
  return e < 0 ? 0 : e;
}

static bool is_tracking(void) { return s_track_received != 0 && s_track_title[0] != '\0'; }

static void resubscribe_tick(void) {
  tick_timer_service_unsubscribe();
  tick_timer_service_subscribe(is_tracking() ? SECOND_UNIT : MINUTE_UNIT, tick_handler);
}

// ---------- render ----------
static bool line_stale(void) {
  return s_last_ok != 0 && (time(NULL) - s_last_ok) > STALE_AFTER_S;
}

static GFont status_font(void) { return fonts_get_system_font(FONT_KEY_GOTHIC_18); }

// Fills s_status_buf + s_status_color from the current state. Kicks a
// cross-slide (and remembers the previous text) whenever the string changes,
// unless it's just the tracking timer ticking (same task) - that would
// stutter every second.
static void render_status(void) {
  char prevbuf[96];
  strncpy(prevbuf, s_status_buf, sizeof(prevbuf));
  s_status_buf[0] = '\0';

  bool qt = quiet_time_is_active();
  s_status_color = PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite);

  if (s_status == 1 && !is_tracking()) {
    strncpy(s_status_buf, "Syncing…", sizeof(s_status_buf));
  } else if (s_status == 2) {
    strncpy(s_status_buf, "Open the app to pair", sizeof(s_status_buf));
  } else if (is_tracking()) {
    int e = track_now_elapsed_s();
    int h = e / 3600, m = (e % 3600) / 60, s = e % 60;
    if (h > 0) {
      snprintf(s_status_buf, sizeof(s_status_buf), "▶ %d:%02d:%02d  %s", h, m, s, s_track_title);
    } else {
      snprintf(s_status_buf, sizeof(s_status_buf), "▶ %d:%02d  %s", m, s, s_track_title);
    }
    s_status_color = PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite);
  } else {
    render_status_stats();
  }

  if (qt) { s_status_color = GColorDarkGray; }
  s_status_buf[sizeof(s_status_buf) - 1] = '\0';

  // marquee only for an overflowing line (long task names)
  GSize sz = graphics_text_layout_get_content_size(
      s_status_buf, status_font(), GRect(0, 0, 1000, 24), GTextOverflowModeFill, GTextAlignmentLeft);
  s_marquee_on = sz.w > 160;
  if (!s_marquee_on) { s_marquee_off = 0; }

  // slide only on a real content change - not the per-second timer of the same task
  bool tick_only = is_tracking() && strstr(s_status_buf, s_track_title) &&
                   strstr(prevbuf, s_track_title);
  if (prevbuf[0] && !tick_only && strncmp(prevbuf, s_status_buf, sizeof(prevbuf)) != 0) {
    strncpy(s_status_prev, prevbuf, sizeof(s_status_prev));
    s_slide_tick = 1;
    kick_anim();
  }
  if (s_marquee_on) { kick_anim(); }
  if (s_status_layer_l) { layer_mark_dirty(s_status_layer_l); }
}

static void render_status_stats(void) {
  const char *prefix = line_stale() ? "~ " : "";
  char a[24], b[24];
  switch (s_line_mode) {
    case 1: // done count
      snprintf(s_status_buf, sizeof(s_status_buf), "%s%d / %d done", prefix, s_done, s_total);
      break;
    case 2: // time worked
      fmt_hm(s_worked_min, a, sizeof(a));
      snprintf(s_status_buf, sizeof(s_status_buf), "%s%s worked", prefix, a);
      break;
    case 3: // estimate remaining
      fmt_hm(s_est_min, a, sizeof(a));
      snprintf(s_status_buf, sizeof(s_status_buf), "%s%s left", prefix, a);
      break;
    case 4: // habits
      if (s_hab_total > 0) {
        if (s_hab_streak >= 2 && s_hab_title[0]) {
          snprintf(s_status_buf, sizeof(s_status_buf), "%s%d/%d habits · %s %d",
                   prefix, s_hab_done, s_hab_total, s_hab_title, s_hab_streak);
        } else {
          snprintf(s_status_buf, sizeof(s_status_buf), "%s%d / %d habits", prefix, s_hab_done, s_hab_total);
        }
      } else {
        snprintf(s_status_buf, sizeof(s_status_buf), "%sNo habits", prefix);
      }
      break;
    default: // 0 = auto: next task, else done count
      if (s_next_min >= 0 && s_next_min < 1440 && s_next_title[0]) {
        fmt_clock(s_next_min, a, sizeof(a));
        snprintf(s_status_buf, sizeof(s_status_buf), "%s→ %s  %s", prefix, a, s_next_title);
      } else if (s_total > 0) {
        fmt_hm(s_worked_min, b, sizeof(b));
        snprintf(s_status_buf, sizeof(s_status_buf), "%s%d/%d done · %s", prefix, s_done, s_total, b);
      } else if (s_worked_min > 0) {
        fmt_hm(s_worked_min, a, sizeof(a));
        snprintf(s_status_buf, sizeof(s_status_buf), "%s%s worked", prefix, a);
      } else {
        snprintf(s_status_buf, sizeof(s_status_buf), "%sNothing planned today", prefix);
      }
      break;
  }
}

// One line, drawn by hand so it can colour, cross-slide on a content change,
// and marquee a long task name.
static void status_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GFont f = status_font();
  graphics_context_set_text_color(ctx, s_status_color);

  int slide = 0;
  if (s_slide_tick > 0) {
    int p = s_slide_tick * 1000 / SLIDE_TICKS;      // 0..1000
    slide = b.size.h * p / 1000;                     // new text rises this far
    // outgoing line, sliding up and out
    graphics_context_set_text_color(ctx, GColorDarkGray);
    graphics_draw_text(ctx, s_status_prev, f, GRect(0, -slide, b.size.w, b.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
    graphics_context_set_text_color(ctx, s_status_color);
  }
  int16_t y = (s_slide_tick > 0) ? (b.size.h - slide) : 0;

  if (s_marquee_on && s_slide_tick == 0) {
    GSize sz = graphics_text_layout_get_content_size(
        s_status_buf, f, GRect(0, 0, 2000, b.size.h), GTextOverflowModeFill, GTextAlignmentLeft);
    int period = sz.w + 40;
    int x = -(s_marquee_off % period);
    graphics_draw_text(ctx, s_status_buf, f, GRect(x, y, sz.w + 8, b.size.h),
                       GTextOverflowModeFill, GTextAlignmentLeft, NULL);
    graphics_draw_text(ctx, s_status_buf, f, GRect(x + period, y, sz.w + 8, b.size.h),
                       GTextOverflowModeFill, GTextAlignmentLeft, NULL);
  } else {
    graphics_draw_text(ctx, s_status_buf, f, GRect(4, y, b.size.w - 8, b.size.h),
                       GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
  }
}

static void anim_tick(void *data) {
  s_anim_timer = NULL;
  bool more = false;

  if (s_ring_shown != s_ring_target) {
    int d = s_ring_target - s_ring_shown;
    int step = d > 0 ? RING_STEP : -RING_STEP;
    if ((d > 0 && step > d) || (d < 0 && step < d)) { step = d; }
    s_ring_shown += step;
    layer_mark_dirty(s_ring_layer);
    more = true;
  }
  if (s_pulse_tick > 0) {
    s_pulse_tick++;
    if (s_pulse_tick > PULSE_TICKS) { s_pulse_tick = 0; }
    else { more = true; }
    layer_mark_dirty(s_ring_layer);
  }
  if (s_slide_tick > 0) {
    s_slide_tick++;
    if (s_slide_tick > SLIDE_TICKS) { s_slide_tick = 0; s_status_prev[0] = '\0'; }
    else { more = true; }
    layer_mark_dirty(s_status_layer_l);
  }
  if (s_marquee_on && s_slide_tick == 0) {
    s_marquee_off += MARQUEE_STEP;
    layer_mark_dirty(s_status_layer_l);
    more = true;
  }

  if (more) { s_anim_timer = app_timer_register(ANIM_STEP_MS, anim_tick, NULL); }
}

static void ring_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GRect r = grect_inset(b, GEdgeInsets(3));
  int frac = s_ring_shown;               // animated, not the raw done/total
  if (frac < 0) { frac = 0; }
  if (frac > 1000) { frac = 1000; }
  bool dim = quiet_time_is_active();
  bool complete = s_total > 0 && s_done >= s_total;

  // faint full track
  graphics_context_set_stroke_color(ctx, PBL_IF_COLOR_ELSE(GColorFromRGB(42, 42, 42), GColorWhite));
  graphics_context_set_stroke_width(ctx, PBL_IF_COLOR_ELSE(3, 1));
  graphics_draw_arc(ctx, r, GOvalScaleModeFitCircle, 0, TRIG_MAX_ANGLE);

  // progress: grey -> deepening green with completion; gold at 100%
  GColor prog;
  if (dim) {
    prog = PBL_IF_COLOR_ELSE(GColorDarkGray, GColorWhite);
  } else if (complete) {
    prog = PBL_IF_COLOR_ELSE(GColorYellow, GColorWhite);
  } else {
    prog = PBL_IF_COLOR_ELSE(GColorFromRGB(0, 130 + frac * 125 / 1000, 45), GColorWhite);
  }
  graphics_context_set_stroke_color(ctx, prog);
  graphics_context_set_stroke_width(ctx, dim ? 2 : 5);
  if (frac > 0) {
    // int32-safe: TRIG_MAX_ANGLE (65536) * frac (<=1000) = 65.5M, well under 2^31.
    graphics_draw_arc(ctx, r, GOvalScaleModeFitCircle, 0,
                      (int32_t)TRIG_MAX_ANGLE * frac / 1000);
  }
  graphics_context_set_stroke_width(ctx, 1);

  // completion flash: a white ring expanding outward and fading
  if (s_pulse_tick > 0) {
    int p = s_pulse_tick * 1000 / PULSE_TICKS;       // 0..1000
    int w = 6 - p * 6 / 1000;                        // 6 -> 0
    if (w > 0) {
      GRect pr = grect_inset(r, GEdgeInsets(-(p * 6 / 1000)));
      graphics_context_set_stroke_color(ctx, GColorWhite);
      graphics_context_set_stroke_width(ctx, w);
      graphics_draw_arc(ctx, pr, GOvalScaleModeFitCircle, 0, TRIG_MAX_ANGLE);
      graphics_context_set_stroke_width(ctx, 1);
    }
  }

  // Week sparkline: seven bars, [6] = today (highlighted). Skipped in Quiet Time.
  if (!dim) {
    int maxv = 1;
    for (int i = 0; i < 7; i++) { if (s_week[i] > maxv) { maxv = s_week[i]; } }
    int bw = 6, gap = 3, total_w = 7 * bw + 6 * gap;
    int x0 = (b.size.w - total_w) / 2;
    int base = b.size.h - 40;
    for (int i = 0; i < 7; i++) {
      int hh = s_week[i] * 12 / maxv;
      if (s_week[i] > 0 && hh < 2) { hh = 2; }
      graphics_context_set_fill_color(ctx, i == 6
          ? PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite)
          : PBL_IF_COLOR_ELSE(GColorFromRGB(60, 110, 150), GColorWhite));
      graphics_fill_rect(ctx, GRect(x0 + i * (bw + gap), base - hh, bw, hh), 0, GCornerNone);
    }
  }
}

static void draw_comma_int(GContext *ctx, GFont f, GRect box, int v, GTextAlignment al) {
  char raw[12], out[16];
  snprintf(raw, sizeof(raw), "%d", v < 0 ? 0 : v);
  int len = strlen(raw), o = 0;
  for (int i = 0; i < len; i++) {
    if (i > 0 && (len - i) % 3 == 0) { out[o++] = ','; }
    out[o++] = raw[i];
  }
  out[o] = '\0';
  graphics_draw_text(ctx, out, f, box, GTextOverflowModeFill, al, NULL);
}

static void top_update_proc(Layer *layer, GContext *ctx) {
  GRect b = layer_get_bounds(layer);
  GColor fg = PBL_IF_COLOR_ELSE(GColorWhite, GColorWhite);
  graphics_context_set_text_color(ctx, fg);

  // steps, left
#if defined(PBL_HEALTH)
  if (s_steps > 0) {
    draw_comma_int(ctx, fonts_get_system_font(FONT_KEY_GOTHIC_14),
                   GRect(6, 0, b.size.w / 2, 16), s_steps, GTextAlignmentLeft);
  }
#endif

  // battery gauge, right - green / amber / red by level, cyan while charging
  BatteryChargeState bat = battery_state_service_peek();
  int px = b.size.w - 6 - 22, py = 5;
  graphics_context_set_stroke_color(ctx, fg);
  graphics_draw_rect(ctx, GRect(px, py, 20, 9));
  graphics_draw_line(ctx, GPoint(px + 20, py + 2), GPoint(px + 20, py + 6));
  GColor bc = bat.is_charging ? PBL_IF_COLOR_ELSE(GColorCyan, GColorWhite)
            : bat.charge_percent <= 10 ? PBL_IF_COLOR_ELSE(GColorRed, GColorWhite)
            : bat.charge_percent <= 25 ? PBL_IF_COLOR_ELSE(GColorChromeYellow, GColorWhite)
            : PBL_IF_COLOR_ELSE(GColorGreen, GColorWhite);
  graphics_context_set_fill_color(ctx, bc);
  graphics_fill_rect(ctx, GRect(px + 2, py + 2, bat.charge_percent * 16 / 100, 5), 0, GCornerNone);

  // phone-disconnected mark, right of the date row area
  if (!s_bt) {
    graphics_context_set_text_color(ctx, PBL_IF_COLOR_ELSE(GColorRed, GColorWhite));
    graphics_draw_text(ctx, "no phone", fonts_get_system_font(FONT_KEY_GOTHIC_14),
                       GRect(b.size.w / 2, 0, b.size.w / 2 - 30, 16),
                       GTextOverflowModeFill, GTextAlignmentRight, NULL);
  }
}

// ---------- time ----------
static void tick_handler(struct tm *t, TimeUnits units) {
  strftime(s_time_buf, sizeof(s_time_buf), clock_is_24h_style() ? "%H:%M" : "%I:%M", t);
  if (!clock_is_24h_style() && s_time_buf[0] == '0') {
    memmove(s_time_buf, s_time_buf + 1, strlen(s_time_buf));
  }
  text_layer_set_text(s_time_layer, s_time_buf);
  strftime(s_date_buf, sizeof(s_date_buf), "%a %d %b", t);
  text_layer_set_text(s_date_layer, s_date_buf);

#if defined(PBL_HEALTH)
  if ((units & MINUTE_UNIT) || s_steps == 0) {
    s_steps = (int)health_service_sum_today(HealthMetricStepCount);
  }
#endif

  if (is_tracking()) {
    render_status(); // ticks the ▶ timer every second
  }
  layer_mark_dirty(s_top_layer);
}

// ---------- messages ----------
static void request_refresh(void) {
  DictionaryIterator *it;
  if (app_message_outbox_begin(&it) != APP_MSG_OK) { return; }
  dict_write_int32(it, KEY_MSG_TYPE, MSG_REFRESH_REQUEST);
  app_message_outbox_send();
}

static void parse_week_csv(const char *csv) {
  for (int i = 0; i < 7; i++) { s_week[i] = 0; }
  int i = 0, v = 0; bool any = false;
  for (const char *p = csv; ; p++) {
    if (*p >= '0' && *p <= '9') { v = v * 10 + (*p - '0'); any = true; }
    else {
      if (any && i < 7) { s_week[i++] = v; }
      v = 0; any = false;
      if (*p == '\0') { break; }
    }
  }
}

static void inbox_received(DictionaryIterator *iter, void *ctx) {
  Tuple *t;
  bool was_tracking = is_tracking();

  if ((t = dict_find(iter, KEY_STATUS))) { s_status = t->value->int32; }
  if ((t = dict_find(iter, KEY_DONE)))   { s_done = t->value->int32; }
  if ((t = dict_find(iter, KEY_TOTAL)))  { s_total = t->value->int32; }
  if ((t = dict_find(iter, KEY_WORKED_MIN))) { s_worked_min = t->value->int32; }
  if ((t = dict_find(iter, KEY_EST_MIN)))    { s_est_min = t->value->int32; }
  if ((t = dict_find(iter, KEY_NEXT_MIN)))   { s_next_min = t->value->int32; }
  if ((t = dict_find(iter, KEY_NEXT_TITLE))) {
    strncpy(s_next_title, t->value->cstring, sizeof(s_next_title));
    s_next_title[sizeof(s_next_title) - 1] = '\0';
  }
  if ((t = dict_find(iter, KEY_HABITS_DONE)))  { s_hab_done = t->value->int32; }
  if ((t = dict_find(iter, KEY_HABITS_TOTAL))) { s_hab_total = t->value->int32; }
  if ((t = dict_find(iter, KEY_HABIT_STREAK))) { s_hab_streak = t->value->int32; }
  if ((t = dict_find(iter, KEY_HABIT_TITLE)))  {
    strncpy(s_hab_title, t->value->cstring, sizeof(s_hab_title));
    s_hab_title[sizeof(s_hab_title) - 1] = '\0';
  }
  if ((t = dict_find(iter, KEY_WEEK_CSV))) { parse_week_csv(t->value->cstring); }

  {
    Tuple *tt = dict_find(iter, KEY_TRACK_TITLE);
    Tuple *te = dict_find(iter, KEY_TRACK_ELAPSED_S);
    if (tt) {
      bool changed = strncmp(s_track_title, tt->value->cstring, sizeof(s_track_title) - 1) != 0;
      strncpy(s_track_title, tt->value->cstring, sizeof(s_track_title));
      s_track_title[sizeof(s_track_title) - 1] = '\0';
      // Only (re)anchor the local timer on a title change or the first update -
      // a same-session re-emit keeps ticking smoothly from the local clock.
      if (te && (changed || s_track_received == 0)) {
        s_track_elapsed_s = te->value->int32;
        s_track_received = time(NULL);
      }
      if (s_track_title[0] == '\0') { s_track_received = time(NULL); } // a clear
    }
  }

  if (s_status == 0) { s_last_ok = time(NULL); }
  if (is_tracking() != was_tracking) { resubscribe_tick(); }

  // animate the ring toward the new fraction; flash once when it just completed
  int new_target = (s_total > 0) ? (s_done * 1000 / s_total) : 0;
  if (new_target > 1000) { new_target = 1000; }
  bool newly_complete = new_target >= 1000 && s_ring_target < 1000;
  s_ring_target = new_target;
  if (newly_complete) { s_pulse_tick = 1; }
  if (s_ring_shown != s_ring_target || s_pulse_tick > 0) { kick_anim(); }

  render_status();
  layer_mark_dirty(s_ring_layer);
}

static void tap_handler(AccelAxisType axis, int32_t direction) {
  s_line_mode = (s_line_mode + 1) % LINE_MODES;
  render_status();
  request_refresh();
}

static void bt_handler(bool connected) {
  s_bt = connected;
  layer_mark_dirty(s_top_layer);
}

// ---------- lifecycle ----------
static void window_load(Window *window) {
  Layer *root = window_get_root_layer(window);
  GRect b = layer_get_bounds(root);
  window_set_background_color(window, GColorBlack);
  int16_t cy = b.size.h / 2;

  s_ring_layer = layer_create(b);
  layer_set_update_proc(s_ring_layer, ring_update_proc);
  layer_add_child(root, s_ring_layer);

  s_top_layer = layer_create(GRect(0, 2, b.size.w, 18));
  layer_set_update_proc(s_top_layer, top_update_proc);
  layer_add_child(root, s_top_layer);

  s_time_layer = text_layer_create(GRect(0, cy - 42, b.size.w, 46));
  text_layer_set_background_color(s_time_layer, GColorClear);
  text_layer_set_text_color(s_time_layer, GColorWhite);
  text_layer_set_font(s_time_layer, fonts_get_system_font(FONT_KEY_BITHAM_42_BOLD));
  text_layer_set_text_alignment(s_time_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_time_layer));

  s_date_layer = text_layer_create(GRect(0, cy + 4, b.size.w, 22));
  text_layer_set_background_color(s_date_layer, GColorClear);
  text_layer_set_text_color(s_date_layer, PBL_IF_COLOR_ELSE(GColorLightGray, GColorWhite));
  text_layer_set_font(s_date_layer, fonts_get_system_font(FONT_KEY_GOTHIC_18));
  text_layer_set_text_alignment(s_date_layer, GTextAlignmentCenter);
  layer_add_child(root, text_layer_get_layer(s_date_layer));

  s_status_layer_l = layer_create(GRect(0, cy + 30, b.size.w, 24));
  layer_set_update_proc(s_status_layer_l, status_update_proc);
  layer_set_clips(s_status_layer_l, true);
  layer_add_child(root, s_status_layer_l);

  s_status_color = PBL_IF_COLOR_ELSE(GColorPictonBlue, GColorWhite);
  time_t now = time(NULL);
  tick_handler(localtime(&now), MINUTE_UNIT);
  render_status();
  if (s_ring_target > 0) { kick_anim(); } // startup sweep
}

static void window_unload(Window *window) {
  if (s_anim_timer) { app_timer_cancel(s_anim_timer); s_anim_timer = NULL; }
  layer_destroy(s_ring_layer);
  layer_destroy(s_top_layer);
  layer_destroy(s_status_layer_l);
  text_layer_destroy(s_time_layer);
  text_layer_destroy(s_date_layer);
}

static void load_persisted(void) {
  if (!persist_exists(PK_TOTAL)) { return; }
  s_done = persist_read_int(PK_DONE);
  s_total = persist_read_int(PK_TOTAL);
  s_worked_min = persist_read_int(PK_WORKED);
  s_est_min = persist_read_int(PK_EST);
  s_next_min = persist_read_int(PK_NEXT_MIN);
  persist_read_string(PK_NEXT_TITLE, s_next_title, sizeof(s_next_title));
  s_hab_done = persist_read_int(PK_HAB_DONE);
  s_hab_total = persist_read_int(PK_HAB_TOTAL);
  s_hab_streak = persist_read_int(PK_HAB_STREAK);
  persist_read_string(PK_HAB_TITLE, s_hab_title, sizeof(s_hab_title));
  if (persist_exists(PK_WEEK)) {
    char csv[64] = "";
    persist_read_string(PK_WEEK, csv, sizeof(csv));
    parse_week_csv(csv);
  }
  s_last_ok = (time_t)persist_read_int(PK_LAST_OK);
  s_status = 0; // show cached data until the fresh sync lands
  s_ring_target = (s_total > 0) ? (s_done * 1000 / s_total) : 0;
  if (s_ring_target > 1000) { s_ring_target = 1000; }
}

static void save_persisted(void) {
  persist_write_int(PK_DONE, s_done);
  persist_write_int(PK_TOTAL, s_total);
  persist_write_int(PK_WORKED, s_worked_min);
  persist_write_int(PK_EST, s_est_min);
  persist_write_int(PK_NEXT_MIN, s_next_min);
  persist_write_string(PK_NEXT_TITLE, s_next_title);
  persist_write_int(PK_HAB_DONE, s_hab_done);
  persist_write_int(PK_HAB_TOTAL, s_hab_total);
  persist_write_int(PK_HAB_STREAK, s_hab_streak);
  persist_write_string(PK_HAB_TITLE, s_hab_title);
  char csv[64];
  snprintf(csv, sizeof(csv), "%d,%d,%d,%d,%d,%d,%d",
           s_week[0], s_week[1], s_week[2], s_week[3], s_week[4], s_week[5], s_week[6]);
  persist_write_string(PK_WEEK, csv);
  persist_write_int(PK_LAST_OK, (int)s_last_ok);
}

static void init(void) {
  load_persisted();

  s_window = window_create();
  window_set_window_handlers(s_window, (WindowHandlers) {
    .load = window_load, .unload = window_unload,
  });
  window_stack_push(s_window, true);

  tick_timer_service_subscribe(MINUTE_UNIT, tick_handler);
  accel_tap_service_subscribe(tap_handler);
  battery_state_service_subscribe(NULL);
  connection_service_subscribe((ConnectionHandlers) { .pebble_app_connection_handler = bt_handler });
  s_bt = connection_service_peek_pebble_app_connection();

  app_message_register_inbox_received(inbox_received);
  app_message_open(512, 64);
}

static void deinit(void) {
  save_persisted();
  connection_service_unsubscribe();
  battery_state_service_unsubscribe();
  accel_tap_service_unsubscribe();
  tick_timer_service_unsubscribe();
  window_destroy(s_window);
}

int main(void) {
  init();
  app_event_loop();
  deinit();
}
