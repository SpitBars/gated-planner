// GatePlan 2.0 - modular, delightful, habit-safe PWA upgrade
// This rewrite focuses on composable helpers, clear data modeling, and UI polish.

const $ = (selector, scope = document) => scope.querySelector(selector);
const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

const STORAGE_KEY = 'gateplan_state_v2';
const DEFAULT_REASONS = {
  success: [],
  partial: ['Made progress', 'Need more time', 'Energy dipped'],
  not_yet: ['Ran out of time', 'Blocked by something', 'Energy was low', 'Forgot', 'Chose rest'],
  skipped: ['No longer relevant', 'Waiting on someone', 'Emergency came up', 'Reprioritized'],
};

const DEFAULT_SETTINGS = {
  morningHour: '07:00',
  minTasks: 1,
  calLinks: 'on',
  streakThreshold: 0.8,
  theme: 'system',
  accentColor: '#6366f1',
  autoReshuffle: 'on',
  pomodoroLength: 25,
  shortBreakLength: 5,
  longBreakLength: 15,
};

const ENERGY_LABELS = {
  1: 'Low',
  2: 'Below baseline',
  3: 'Balanced',
  4: 'Engaged',
  5: 'Peak',
};

let state = createInitialState();
let deferredInstallPrompt = null;
let focusTimerState = createDefaultFocusTimerState();
let focusTimerInterval = null;
let pendingSyncCount = 0;
let activeRecognition = null;

function createInitialState() {
  return {
    version: 2,
    tasks: [],
    days: [],
    streak: 0,
    bestStreak: 0,
    streakHistory: [],
    lastCheckinDate: null,
     coach: {
       lastSuggested: null,
       suggestions: [],
       insights: [],
       streakAssistActive: false,
     },
     metrics: {
       focusSessions: [],
       signals: [],
     },
     calendar: {
       events: [],
       conflicts: [],
       lastImport: null,
     },
     gamification: {
       xp: 0,
       level: 1,
       badges: [],
       seasonalChallenges: defaultSeasonalChallenges(),
     },
    settings: { ...DEFAULT_SETTINGS },
  };
}

function defaultSeasonalChallenges() {
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  return [
    {
      id: 'streak-surge',
      title: 'Sustain 5 streak days',
      goal: 5,
      progress: 0,
      endsAt: end.toISOString(),
    },
    {
      id: 'deep-focus',
      title: 'Log 300 focus minutes',
      goal: 300,
      progress: 0,
      endsAt: end.toISOString(),
    },
  ];
}

function createDefaultFocusTimerState() {
  return {
    taskId: '',
    running: false,
    elapsedSeconds: 0,
    startedAt: null,
    laps: [],
    mode: 'focus',
    completedPomodoros: 0,
    lastTick: null,
  };
}

function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function migrateState(raw) {
  const base = createInitialState();
  if (!raw || typeof raw !== 'object') return base;

  const merged = { ...base, ...raw };
  merged.settings = { ...DEFAULT_SETTINGS, ...(raw.settings || {}) };
  merged.coach = { ...base.coach, ...(raw.coach || {}) };
  const rawFocusSessions = Array.isArray(raw?.metrics?.focusSessions) ? raw.metrics.focusSessions : base.metrics.focusSessions;
  const rawSignals = Array.isArray(raw?.metrics?.signals) ? raw.metrics.signals : base.metrics.signals;
  merged.metrics = {
    focusSessions: rawFocusSessions
      .map((session) => ({
        id: session?.id || crypto.randomUUID(),
        taskId: session?.taskId || null,
        title: session?.title || 'Focus block',
        minutes: Number(session?.minutes) || Number(session?.actualMinutes) || 0,
        startedAt: session?.startedAt || null,
        completedAt: session?.completedAt || session?.endedAt || null,
        planned: Number(session?.planned) || Number(session?.plannedDuration) || 0,
        mode: session?.mode || 'focus',
        date: session?.date || (session?.startedAt ? todayKey(new Date(session.startedAt)) : todayKey()),
      })),
    signals: rawSignals
      .map((signal) => ({
        date: signal?.date || todayKey(),
        energy: clamp(Number(signal?.energy) || 3, 1, 5),
        mood: signal?.mood || 'steady',
        biometrics: signal?.biometrics || '',
        ratio: typeof signal?.ratio === 'number' ? clamp(signal.ratio, 0, 1) : null,
      })),
  };
  merged.calendar = { ...base.calendar, ...(raw.calendar || {}) };
  merged.calendar.conflicts = Array.isArray(merged.calendar.conflicts) ? merged.calendar.conflicts : [];
  merged.calendar.events = Array.isArray(merged.calendar.events)
    ? merged.calendar.events.map((event) => {
        const startMinutes =
          typeof event?.startMinutes === 'number'
            ? event.startMinutes
            : timeToMinutes(event?.startTime) ?? null;
        const endMinutes =
          typeof event?.endMinutes === 'number'
            ? event.endMinutes
            : timeToMinutes(event?.endTime) ?? null;
        return {
          id: event?.id || crypto.randomUUID(),
          title: event?.title || 'Calendar event',
          date: event?.date || todayKey(),
          startMinutes,
          endMinutes,
          startTime: event?.startTime || (startMinutes != null ? minutesToTime(startMinutes) : ''),
          endTime: event?.endTime || (endMinutes != null ? minutesToTime(endMinutes) : ''),
        };
      })
    : [];
  merged.gamification = { ...base.gamification, ...(raw.gamification || {}) };
  if (!Array.isArray(merged.gamification.seasonalChallenges) || !merged.gamification.seasonalChallenges.length) {
    merged.gamification.seasonalChallenges = defaultSeasonalChallenges();
  }

  merged.tasks = Array.isArray(raw.tasks)
    ? raw.tasks
        .map((task) => ({
          id: task?.id || crypto.randomUUID(),
          title: String(task?.title || 'Untitled task'),
          defDur: Number(task?.defDur) || 30,
          due: task?.due || null,
          tags: Array.isArray(task?.tags)
            ? task.tags.filter(Boolean)
            : typeof task?.tags === 'string'
            ? task.tags.split(',').map((t) => t.trim()).filter(Boolean)
            : [],
        }))
    : base.tasks;

  if (Array.isArray(raw.days)) {
    merged.days = raw.days.map(normalizeDay).filter(Boolean);
  } else if (Array.isArray(raw.todayPlan)) {
    // Legacy structure -> migrate.
    merged.days = raw.todayPlan.map((entry) => {
      const items = Array.isArray(entry?.items)
        ? entry.items.map((it) => normalizeItem({
            id: it?.id || crypto.randomUUID(),
            title: it?.title || 'Task',
            start: it?.start || null,
            duration: Number(it?.duration) || Number(it?.defDur) || 30,
            status: it?.status || null,
            partial: typeof it?.partial === 'number' ? it.partial : 100,
            reasons: it?.reason ? [String(it.reason)] : Array.isArray(it?.reasons) ? it.reasons : [],
            note: it?.note || '',
            taskId: it?.taskId || null,
          }))
        : [];
      return normalizeDay({
        date: entry?.date,
        items,
        planned: !!entry?.planned,
        checked: !!entry?.checked,
        freeTomorrow: !!entry?.freeTomorrow,
        summary: entry?.summary || null,
      });
    });
  } else {
    merged.days = base.days;
  }

  merged.streak = Number(raw.streak) || 0;
  merged.bestStreak = Number(raw.bestStreak) || merged.streak || 0;
  merged.streakHistory = Array.isArray(raw.streakHistory)
    ? raw.streakHistory
        .map((row) => ({ date: row?.date || todayKey(), streak: Number(row?.streak) || 0 }))
        .slice(-120)
    : [];
  merged.lastCheckinDate = raw.lastCheckinDate || null;

  return merged;
}

function normalizeDay(day) {
  if (!day?.date) return null;
  return {
    date: day.date,
    items: Array.isArray(day.items) ? day.items.map(normalizeItem).filter(Boolean) : [],
    planned: !!day.planned,
    checked: !!day.checked,
    freeTomorrow: !!day.freeTomorrow,
    summary: day.summary || null,
  };
}

function normalizeItem(item) {
  if (!item) return null;
  return {
    id: item.id || crypto.randomUUID(),
    taskId: item.taskId || null,
    title: item.title || 'Task',
    start: item.start || null,
    duration: Number(item.duration) || 30,
    status: item.status || null,
    partial: typeof item.partial === 'number' ? clamp(item.partial, 0, 100) : item.status === 'success' ? 100 : 0,
    reasons: Array.isArray(item.reasons)
      ? item.reasons.filter(Boolean)
      : item.reason
      ? [String(item.reason)]
      : [],
    note: item.note || '',
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function timeToMinutes(time) {
  if (!time) return null;
  const [hours, minutes] = time.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) return null;
  return hours * 60 + minutes;
}

function minutesToTime(minutes) {
  const safe = Math.max(0, minutes);
  const hrs = Math.floor(safe / 60) % 24;
  const mins = Math.round(safe % 60);
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}`;
}

function daysUntil(dateString) {
  if (!dateString) return Infinity;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, d] = dateString.split('-').map(Number);
  const target = new Date(y, (m || 1) - 1, d || 1);
  target.setHours(0, 0, 0, 0);
  const diff = target - today;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function loadState() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return createInitialState();
    const parsed = JSON.parse(saved);
    return migrateState(parsed);
  } catch (error) {
    console.error('Failed to parse saved GatePlan state', error);
    return createInitialState();
  }
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    updateLastSync();
    queueStateForSync();
  } catch (error) {
    console.error('Unable to persist GatePlan state', error);
  }
}

function updateLastSync() {
  const stamp = new Date();
  $('#lastSync').textContent = `Last saved ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

async function queueStateForSync() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    const snapshot = {
      version: state.version,
      timestamp: new Date().toISOString(),
      streak: state.streak,
      tasks: state.tasks.length,
    };
    const target = registration.active || navigator.serviceWorker.controller;
    target?.postMessage({ type: 'state-sync', payload: snapshot });
    if ('sync' in registration) {
      await registration.sync.register('gateplan-state-sync');
    }
  } catch (error) {
    console.debug('Background sync unavailable', error);
  }
}

function ensureDay(dateKey = todayKey()) {
  let day = state.days.find((entry) => entry.date === dateKey);
  if (!day) {
    day = normalizeDay({ date: dateKey, items: [], planned: false, checked: false, freeTomorrow: false });
    state.days.push(day);
  }
  return day;
}

function ensureDemoTasks() {
  if (state.tasks.length > 0) return;
  state.tasks.push(
    { id: crypto.randomUUID(), title: 'Deep work sprint', defDur: 60, due: null, tags: ['focus'] },
    { id: crypto.randomUUID(), title: 'Movement / workout', defDur: 45, due: null, tags: ['health'] },
    { id: crypto.randomUUID(), title: 'Read 30 pages', defDur: 30, due: null, tags: ['learning'] }
  );
}

function hydrateUI() {
  renderDateInfo();
  renderTasks();
  if (!state.coach?.suggestions?.length && state.tasks.length) {
    state.coach.suggestions = generateCoachSuggestions();
    state.coach.lastSuggested = new Date().toISOString();
  }
  renderCoach();
  renderTodayViews();
  renderCheckinList();
  renderReview();
  renderGamification();
  renderSignalInsight();
  applySettingsToUI();
  applyTheme();
  updateOfflineBanner();
  maybeShowGate();
}

function renderDateInfo() {
  $('#dateInfo').textContent = new Date().toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric'
  });
  $('#streakInfo').textContent = `Streak: ${state.streak} 🔥`;
}

function renderTasks() {
  renderPoolSelect();
  renderPoolList();
}

function renderCoach() {
  const list = $('#coachSuggestionList');
  if (!list) return;
  list.innerHTML = '';
  const suggestions = state.coach?.suggestions || [];
  if (!suggestions.length) {
    list.innerHTML = '<li class="empty-state">Tap refresh to let GatePlan draft your morning lineup.</li>';
  } else {
    suggestions.forEach((suggestion) => {
      const li = document.createElement('li');
      li.className = 'coach-item';
      const title = document.createElement('strong');
      title.textContent = suggestion.title;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      if (suggestion.start) {
        const startBadge = document.createElement('span');
        startBadge.className = 'badge';
        startBadge.textContent = suggestion.start;
        meta.append(startBadge);
      }
      const durationBadge = document.createElement('span');
      durationBadge.className = 'badge';
      durationBadge.textContent = `${suggestion.duration} min`;
      meta.append(durationBadge);
      const reason = document.createElement('p');
      reason.className = 'muted';
      reason.textContent = suggestion.reason;
      li.append(title, meta, reason);
      list.append(li);
    });
  }

  const summary = $('#coachSummary');
  if (summary) {
    if (state.coach?.lastSuggested) {
      const stamp = new Date(state.coach.lastSuggested);
      summary.textContent = `Refreshed ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    } else {
      summary.textContent = 'Let GatePlan study your habits to prime the perfect morning.';
    }
  }

  const alert = $('#coachAlerts');
  if (alert) {
    if (state.coach?.streakAssistActive) {
      alert.textContent = 'Streak recovery mode on: suggestions prioritize confidence-building wins.';
      alert.classList.add('active');
    } else {
      alert.textContent = '';
      alert.classList.remove('active');
    }
  }
}

function refreshCoachSuggestions(force = false) {
  state.coach.suggestions = generateCoachSuggestions(force);
  state.coach.lastSuggested = new Date().toISOString();
  saveState();
  renderCoach();
  renderCalendarConflicts();
}

function generateCoachSuggestions(force = false) {
  const day = ensureDay();
  const plannedIds = new Set(day.items.map((item) => item.taskId));
  const recentSignals = state.metrics.signals.slice(-7);
  const avgEnergy = recentSignals.length
    ? recentSignals.reduce((sum, entry) => sum + entry.energy, 0) / recentSignals.length
    : 3;
  const recentDays = state.days
    .filter((entry) => entry.summary)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 21);

  const suggestions = state.tasks
    .map((task) => {
      const history = recentDays.flatMap((entry) => entry.items.filter((item) => item.taskId === task.id));
      const attempts = history.length || 0;
      const wins = history.filter((item) => item.status === 'success').length;
      const successRate = attempts ? wins / attempts : 0.5;
      const dueIn = daysUntil(task.due);
      const dueScore = Number.isFinite(dueIn) ? Math.max(0, 14 - dueIn) : 0;
      const focusMinutes = state.metrics.focusSessions
        .filter((session) => session.taskId === task.id)
        .reduce((sum, session) => sum + session.minutes, 0);
      const momentumScore = Math.max(0, 60 - focusMinutes);
      let baseScore = (1 - successRate) * 40 + dueScore + momentumScore * 0.1;
      let reason = 'Fresh rotation keeps things interesting.';
      if (dueIn <= 2) {
        reason = 'Time-sensitive: due soon.';
        baseScore += 20;
      } else if (successRate < 0.5 && attempts > 0) {
        reason = 'Needs a win to rebuild confidence.';
        baseScore += 10;
      } else if (avgEnergy <= 2) {
        if (task.defDur <= 30) {
          reason = 'Short burst fits your current energy.';
          baseScore += 8;
        } else {
          baseScore -= 5;
        }
      }
      if (plannedIds.has(task.id) && !force) {
        baseScore -= 25;
      }
      return { task, score: baseScore, reason };
    })
    .filter((entry) => entry.score > -10)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(state.settings.minTasks, 3));

  let nextStart = getNextStartTime(day);
  return suggestions.map((entry) => {
    const start = nextStart ? minutesToTime(nextStart) : null;
    nextStart = nextStart ? nextStart + entry.task.defDur : null;
    return {
      id: crypto.randomUUID(),
      taskId: entry.task.id,
      title: entry.task.title,
      duration: entry.task.defDur,
      start,
      reason: entry.reason,
    };
  });
}

function getNextStartTime(day) {
  const base = timeToMinutes(state.settings.morningHour || '07:00') ?? 420;
  const scheduled = day.items
    .map((item) => ({
      start: timeToMinutes(item.start),
      end: timeToMinutes(item.start) !== null ? timeToMinutes(item.start) + (item.duration || 30) : null,
    }))
    .filter((slot) => slot.start !== null && slot.end !== null)
    .sort((a, b) => a.end - b.end);
  if (!scheduled.length) return base;
  const last = scheduled[scheduled.length - 1];
  return last.end;
}

function applyCoachSuggestions() {
  const suggestions = state.coach?.suggestions || [];
  if (!suggestions.length) {
    toast('No suggestions yet. Refresh first.');
    return;
  }
  const day = ensureDay();
  let added = 0;
  suggestions.forEach((suggestion) => {
    if (day.items.some((item) => item.taskId === suggestion.taskId)) return;
    const newItem = normalizeItem({
      id: crypto.randomUUID(),
      taskId: suggestion.taskId,
      title: suggestion.title,
      start: suggestion.start,
      duration: suggestion.duration,
      status: null,
      partial: 0,
      reasons: [],
      note: '',
    });
    day.items.push(newItem);
    added += 1;
  });
  if (!added) {
    toast('All suggestions already exist in today’s plan.');
    return;
  }
  if (day.items.length >= state.settings.minTasks) {
    day.planned = true;
  }
  saveState();
  renderTodayViews();
  renderCheckinList();
  renderCoach();
  renderCalendarConflicts();
  toast('Coach suggestions added to your plan.');
}

function updateCoachInsights(day, ratio) {
  const insights = [];
  const threshold = state.settings.streakThreshold || DEFAULT_SETTINGS.streakThreshold;
  if (!day.freeTomorrow && ratio < threshold) {
    insights.push('Yesterday slipped under your streak goal. Lean on shorter, confidence-boosting tasks.');
  }
  const signals = state.metrics.signals.slice(-7);
  if (signals.length >= 3) {
    const avgEnergy = signals.reduce((sum, entry) => sum + entry.energy, 0) / signals.length;
    if (avgEnergy <= 2.5) {
      insights.push('Energy trended low this week—front-load lighter work and prioritize recovery blocks.');
    }
    const moodDown = signals.filter((entry) => entry.mood === 'stressed' || entry.mood === 'fatigued').length;
    if (moodDown >= 2) {
      insights.push('Stress surfaced multiple times. Add a buffer or restorative break into tomorrow’s plan.');
    }
  }
  if (!insights.length) {
    insights.push('Momentum holds steady. Keep compounding wins with a balanced mix of stretch and easy tasks.');
  }
  state.coach.insights = insights.slice(0, 4);
}

function maybeAutoReshuffle() {
  if (state.settings.autoReshuffle !== 'on') {
    state.coach.streakAssistActive = false;
    renderCoach();
    return;
  }
  const recent = state.days
    .filter((day) => day.summary)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 3);
  const misses = recent.filter((day) => (day.summary?.ratio || 0) < (state.settings.streakThreshold || 0.8)).length;
  const wasActive = state.coach.streakAssistActive;
  const activate = misses >= 2;
  let changed = wasActive !== activate;
  state.coach.streakAssistActive = activate;
  if (activate) {
    state.coach.suggestions = generateCoachSuggestions(true);
    state.coach.lastSuggested = new Date().toISOString();
    changed = true;
  }
  if (changed) {
    saveState();
  }
  renderCoach();
}

function renderCalendarConflicts() {
  const list = $('#calendarConflictList');
  if (!list) return;
  const summary = $('#calendarSyncSummary');
  if (summary) {
    summary.textContent = state.calendar.lastImport
      ? `Last synced ${new Date(state.calendar.lastImport).toLocaleString([], { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' })}`
      : 'Pull existing events to avoid collisions.';
  }
  const day = ensureDay();
  const conflicts = detectCalendarConflicts(day);
  list.innerHTML = '';
  if (!state.calendar.events?.length) {
    list.innerHTML = '<li class="empty-state">No calendar events imported yet.</li>';
    return;
  }
  if (!conflicts.length) {
    list.innerHTML = '<li class="empty-state">No conflicts detected. You’re clear to focus.</li>';
    return;
  }
  conflicts.forEach(({ task, event }) => {
    const li = document.createElement('li');
    li.className = 'conflict-item';
    const title = document.createElement('strong');
    title.textContent = `${task.title} overlaps with ${event.title}`;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${task.start || '—'}–${minutesToTime((timeToMinutes(task.start) || 0) + task.duration)} vs ${event.startTime}–${event.endTime}`;
    li.append(title, meta);
    list.append(li);
  });
}

function detectCalendarConflicts(day) {
  const events = (state.calendar.events || []).filter((event) => event.date === day.date);
  const conflicts = [];
  day.items.forEach((item) => {
    if (!item.start) return;
    const taskStart = timeToMinutes(item.start);
    const taskEnd = taskStart + (item.duration || 0);
    events.forEach((event) => {
      if (event.startMinutes == null || event.endMinutes == null) return;
      const overlap = Math.max(taskStart, event.startMinutes) < Math.min(taskEnd, event.endMinutes);
      if (overlap) {
        conflicts.push({ task: item, event });
      }
    });
  });
  state.calendar.conflicts = conflicts;
  return conflicts;
}

function handleCalendarImport(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const text = event.target.result;
      const events = parseICSEvents(text);
      state.calendar.events = events;
      state.calendar.lastImport = new Date().toISOString();
      saveState();
      renderCalendarConflicts();
      toast(`Imported ${events.length} calendar event${events.length === 1 ? '' : 's'}.`);
    } catch (error) {
      console.error('Calendar import failed', error);
      alert('Unable to import calendar. Please try another file.');
    }
  };
  reader.readAsText(file);
}

function parseICSEvents(text) {
  const blocks = text.split('BEGIN:VEVENT').slice(1);
  return blocks
    .map((block) => normalizeCalendarEvent(block))
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeCalendarEvent(block) {
  const summaryMatch = block.match(/SUMMARY:(.*)/);
  const startMatch = block.match(/DTSTART[^:]*:(.*)/);
  const endMatch = block.match(/DTEND[^:]*:(.*)/);
  if (!startMatch || !endMatch) return null;
  const start = parseICSTimestamp(startMatch[1].trim());
  const end = parseICSTimestamp(endMatch[1].trim());
  if (!start || !end) return null;
  const dateKey = todayKey(start);
  return {
    id: crypto.randomUUID(),
    title: summaryMatch ? summaryMatch[1].trim() : 'Calendar event',
    date: dateKey,
    startMinutes: start.getHours() * 60 + start.getMinutes(),
    endMinutes: end.getHours() * 60 + end.getMinutes(),
    startTime: start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    endTime: end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  };
}

function parseICSTimestamp(value) {
  if (!value) return null;
  // Handle values like 20240420T090000Z or local times without Z.
  const cleaned = value.replace(/Z$/, '');
  const parts = cleaned.split('T');
  if (parts.length !== 2) return null;
  const datePart = parts[0];
  const timePart = parts[1];
  const year = Number(datePart.slice(0, 4));
  const month = Number(datePart.slice(4, 6)) - 1;
  const day = Number(datePart.slice(6, 8));
  const hour = Number(timePart.slice(0, 2));
  const minute = Number(timePart.slice(2, 4));
  const second = Number(timePart.slice(4, 6));
  return new Date(year, month, day, hour, minute, second || 0);
}

function autoAdjustPlanFromCalendar() {
  const day = ensureDay();
  const conflicts = detectCalendarConflicts(day);
  if (!conflicts.length) {
    toast('No conflicts to adjust.');
    return;
  }
  conflicts.forEach(({ task, event }) => {
    const buffer = 5;
    const newStart = minutesToTime(event.endMinutes + buffer);
    task.start = newStart;
  });
  saveState();
  renderTodayViews();
  renderCalendarConflicts();
  toast('Plan auto-adjusted to avoid conflicts.');
}
function renderTodayViews() {
  renderTodayPlanList();
  renderTodayLiveList();
  updatePlanSummary();
  updateTodayProgress();
  updateFocusTimerOptions();
  renderFocusEffortStats();
  renderFocusTimerLog();
  renderCalendarConflicts();
}

function renderPoolSelect() {
  const select = $('#planTaskSelect');
  select.innerHTML = '';
  if (!state.tasks.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Add tasks to your pool first';
    select.append(opt);
    select.disabled = true;
    return;
  }
  select.disabled = false;
  state.tasks.forEach((task, idx) => {
    const opt = document.createElement('option');
    opt.value = task.id;
    opt.textContent = task.title;
    if (idx === 0) opt.selected = true;
    select.append(opt);
  });
}

function renderPoolList() {
  const list = $('#poolList');
  list.innerHTML = '';
  if (!state.tasks.length) {
    list.innerHTML = `<li class="empty-state">No tasks yet. Capture a few go-to moves to speed up planning.</li>`;
    return;
  }
  state.tasks.forEach((task) => {
    const li = document.createElement('li');
    const header = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = task.title;
    header.append(title);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const duration = document.createElement('span');
    duration.className = 'badge';
    duration.textContent = `${task.defDur} min`;
    meta.append(duration);
    if (task.due) {
      const due = document.createElement('span');
      due.className = 'badge';
      due.textContent = `Due ${task.due}`;
      meta.append(due);
    }
    if (task.tags?.length) {
      const tags = document.createElement('span');
      tags.textContent = `#${task.tags.join(', #')}`;
      meta.append(tags);
    }
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = 'Delete';
    deleteBtn.className = 'danger';
    deleteBtn.addEventListener('click', () => {
      if (!confirm(`Remove "${task.title}" from the pool?`)) return;
      state.tasks = state.tasks.filter((t) => t.id !== task.id);
      saveState();
      renderTasks();
    });
    actions.append(deleteBtn);
    li.append(header, meta, actions);
    list.append(li);
  });
}

function renderTodayPlanList() {
  const list = $('#todayPlanList');
  list.innerHTML = '';
  const day = ensureDay();
  if (!day.items.length) {
    list.innerHTML = `<li class="empty-state">No tasks planned yet. Add at least ${state.settings.minTasks} to unlock the day.</li>`;
    return;
  }

  const sorted = [...day.items].sort((a, b) => {
    if (!a.start && !b.start) return 0;
    if (!a.start) return 1;
    if (!b.start) return -1;
    return a.start.localeCompare(b.start);
  });

  sorted.forEach((item) => {
    const li = document.createElement('li');
    li.dataset.id = item.id;
    const header = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title;
    header.append(title);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (item.start) {
      const start = document.createElement('span');
      start.className = 'badge';
      start.textContent = item.start;
      meta.append(start);
    }
    const duration = document.createElement('span');
    duration.className = 'badge';
    duration.textContent = `${item.duration} min`;
    meta.append(duration);
    const actions = document.createElement('div');
    actions.className = 'card-actions';
    if (state.settings.calLinks === 'on') {
      const link = document.createElement('a');
      link.href = makeGCalLink(item);
      link.target = '_blank';
      link.rel = 'noreferrer';
      link.textContent = 'Add to Google Calendar';
      link.className = 'muted';
      actions.append(link);
    }
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      const today = ensureDay();
      today.items = today.items.filter((it) => it.id !== item.id);
      if (today.items.length < state.settings.minTasks) {
        today.planned = false;
      }
      saveState();
      renderTodayViews();
      renderCheckinList();
      maybeShowGate();
    });
    actions.append(removeBtn);
    li.append(header, meta, actions);
    list.append(li);
  });
}

function renderTodayLiveList() {
  const list = $('#todayLiveList');
  list.innerHTML = '';
  const day = ensureDay();
  if (!day.items.length) {
    list.innerHTML = `<li class="empty-state">All clear. Plan tasks to see them here.</li>`;
    return;
  }
  const focusMinutes = getFocusMinutesByTask(todayKey());
  day.items.forEach((item) => {
    const li = document.createElement('li');
    const header = document.createElement('div');
    const title = document.createElement('strong');
    title.textContent = item.title;
    header.append(title);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    if (item.start) {
      const start = document.createElement('span');
      start.className = 'badge';
      start.textContent = item.start;
      meta.append(start);
    }
    const duration = document.createElement('span');
    duration.className = 'badge';
    duration.textContent = `${item.duration} min`;
    meta.append(duration);
    const focusKey = item.taskId || item.id;
    if (focusKey && focusMinutes.has(focusKey)) {
      const actual = document.createElement('span');
      actual.className = 'badge subtle';
      actual.textContent = `${focusMinutes.get(focusKey)} min logged`;
      meta.append(actual);
    }
    header.append(meta);

    const statusWrap = document.createElement('div');
    if (item.status) {
      const statusTag = document.createElement('span');
      statusTag.className = `status-tag ${item.status}`;
      statusTag.textContent = formatStatusLabel(item);
      statusWrap.append(statusTag);
    } else {
      const placeholder = document.createElement('span');
      placeholder.className = 'muted';
      placeholder.textContent = 'Awaiting check-in';
      statusWrap.append(placeholder);
    }

    li.append(header, statusWrap);

    if (item.note) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = item.note;
      li.append(note);
    }
    list.append(li);
  });
}

function getFocusMinutesByTask(dateKey = todayKey()) {
  const map = new Map();
  state.metrics.focusSessions
    .filter((session) => session.date === dateKey && session.taskId)
    .forEach((session) => {
      map.set(session.taskId, (map.get(session.taskId) || 0) + Math.round(session.minutes));
    });
  return map;
}

function updateFocusTimerOptions() {
  const select = $('#focusTimerTask');
  if (!select) return;
  const day = ensureDay();
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = day.items.length ? 'Select task' : 'Plan tasks first';
  select.append(placeholder);
  day.items.forEach((item) => {
    const opt = document.createElement('option');
    opt.value = item.taskId || item.id;
    opt.textContent = item.title;
    select.append(opt);
  });
  const matching = Array.from(select.options).find((opt) => opt.value === focusTimerState.taskId);
  if (matching) {
    select.value = focusTimerState.taskId;
  } else {
    focusTimerState.taskId = '';
    select.value = '';
  }
  select.disabled = !day.items.length;
}

function renderFocusEffortStats() {
  const container = $('#focusEffortStats');
  if (!container) return;
  const day = ensureDay();
  if (!day.items.length) {
    container.textContent = '';
    return;
  }
  const planned = day.items.reduce((sum, item) => sum + (item.duration || 0), 0);
  const actual = state.metrics.focusSessions
    .filter((session) => session.date === day.date)
    .reduce((sum, session) => sum + (session.minutes || 0), 0);
  const delta = actual - planned;
  const deltaText = delta === 0 ? 'on target' : delta > 0 ? `+${delta} min` : `${delta} min`;
  container.textContent = `Focus minutes logged ${Math.round(actual)} / ${planned} (${deltaText})`;
}

function renderFocusTimerLog() {
  const list = $('#focusTimerLog');
  if (!list) return;
  const sessions = state.metrics.focusSessions.filter((session) => session.date === todayKey());
  list.innerHTML = '';
  if (!sessions.length) {
    list.innerHTML = '<li class="empty-state">No focus blocks logged yet.</li>';
    return;
  }
  sessions
    .slice(-5)
    .reverse()
    .forEach((session) => {
      const li = document.createElement('li');
      li.className = 'focus-log-item';
      const title = document.createElement('strong');
      title.textContent = session.title;
      const meta = document.createElement('div');
      meta.className = 'item-meta';
      const duration = document.createElement('span');
      duration.className = 'badge';
      duration.textContent = `${Math.round(session.minutes)} min`;
      meta.append(duration);
      if (session.planned) {
        const planned = document.createElement('span');
        planned.className = 'badge subtle';
        planned.textContent = `${session.planned} planned`;
        meta.append(planned);
      }
      const time = document.createElement('span');
      time.className = 'muted';
      if (session.startedAt) {
        const start = new Date(session.startedAt);
        time.textContent = start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      }
      li.append(title, meta, time);
      list.append(li);
    });
}

function updateFocusTimerModeLabel() {
  const label = $('#focusTimerMode');
  if (!label) return;
  label.textContent = `Pomodoro ${state.settings.pomodoroLength}:${state.settings.shortBreakLength}`;
}

function startFocusTimer() {
  const select = $('#focusTimerTask');
  if (!select) return;
  const taskId = select.value;
  if (!taskId) {
    toast('Pick a task before starting the timer.');
    return;
  }
  focusTimerState.taskId = taskId;
  if (!focusTimerState.running) {
    focusTimerState.startedAt = focusTimerState.startedAt || new Date().toISOString();
    focusTimerState.running = true;
    focusTimerState.lastTick = Date.now();
  }
  if (focusTimerInterval) clearInterval(focusTimerInterval);
  focusTimerInterval = setInterval(() => {
    tickFocusTimer();
    updateFocusTimerDisplay();
  }, 1000);
  updateFocusTimerDisplay();
}

function pauseFocusTimer() {
  if (!focusTimerState.running) return;
  tickFocusTimer();
  focusTimerState.running = false;
  focusTimerState.lastTick = null;
  if (focusTimerInterval) {
    clearInterval(focusTimerInterval);
    focusTimerInterval = null;
  }
  updateFocusTimerDisplay();
}

function completeFocusTimer() {
  if (!focusTimerState.taskId) {
    toast('Select a task to log focus time.');
    return;
  }
  if (focusTimerState.running) {
    pauseFocusTimer();
  }
  const minutes = Math.round(focusTimerState.elapsedSeconds / 60);
  if (!minutes) {
    toast('Work at least a minute before logging a session.');
    return;
  }
  const day = ensureDay();
  const task = day.items.find((item) => item.taskId === focusTimerState.taskId || item.id === focusTimerState.taskId);
  const session = {
    id: crypto.randomUUID(),
    taskId: task?.taskId || task?.id || focusTimerState.taskId,
    title: task?.title || 'Focus block',
    minutes,
    planned: task?.duration || 0,
    startedAt: focusTimerState.startedAt,
    completedAt: new Date().toISOString(),
    mode: focusTimerState.mode,
    date: todayKey(),
  };
  state.metrics.focusSessions.push(session);
  state.metrics.focusSessions = state.metrics.focusSessions.slice(-200);
  state.gamification.seasonalChallenges = (state.gamification.seasonalChallenges || []).map((challenge) => {
    if (challenge.id === 'deep-focus') {
      const updated = Math.min(challenge.goal, (challenge.progress || 0) + minutes);
      return { ...challenge, progress: updated };
    }
    return challenge;
  });
  focusTimerState.elapsedSeconds = 0;
  focusTimerState.startedAt = null;
  focusTimerState.lastTick = null;
  focusTimerState.running = false;
  saveState();
  renderFocusEffortStats();
  renderFocusTimerLog();
  renderTodayLiveList();
  renderGamification();
  updateFocusTimerDisplay();
  toast('Focus session logged.');
}

function tickFocusTimer() {
  if (!focusTimerState.running) return;
  const now = Date.now();
  if (!focusTimerState.lastTick) {
    focusTimerState.lastTick = now;
    return;
  }
  const diff = (now - focusTimerState.lastTick) / 1000;
  focusTimerState.elapsedSeconds += diff;
  focusTimerState.lastTick = now;
}

function updateFocusTimerDisplay() {
  const display = $('#focusTimerDisplay');
  if (!display) return;
  const total = Math.round(focusTimerState.elapsedSeconds);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  display.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatStatusLabel(item) {
  if (item.status === 'partial') {
    return `Partial ${item.partial || 0}%`;
  }
  if (item.status === 'not_yet') return 'Not yet';
  if (item.status === 'skipped') return 'Skipped';
  return 'Success';
}

function updatePlanSummary() {
  const day = ensureDay();
  const total = day.items.length;
  const totalMinutes = day.items.reduce((acc, item) => acc + (item.duration || 0), 0);
  $('#planSummary').textContent = total
    ? `${total} task${total === 1 ? '' : 's'} • ${totalMinutes} minutes`
    : 'No tasks yet.';
  $('#planProgressLabel').textContent = `${total}/${state.settings.minTasks}`;
  const progress = Math.min(1, total / Math.max(1, state.settings.minTasks));
  $('#planProgressBar').style.width = `${progress * 100}%`;
}

function calculateCompletion(items) {
  if (!items.length) return { weighted: 0, total: 0 };
  const weighted = items.reduce((sum, item) => {
    if (item.status === 'success') return sum + 1;
    if (item.status === 'partial') return sum + (item.partial || 0) / 100;
    return sum;
  }, 0);
  return { weighted, total: items.length };
}

function updateTodayProgress() {
  const day = ensureDay();
  const { weighted, total } = calculateCompletion(day.items);
  const percent = total ? Math.round((weighted / total) * 100) : 0;
  $('#todayProgressLabel').textContent = total ? `${weighted.toFixed(weighted % 1 === 0 ? 0 : 1)}/${total}` : '0/0';
  $('#todayProgressBar').style.width = `${percent}%`;
}

function renderCheckinList() {
  const list = $('#checkinList');
  list.innerHTML = '';
  const day = ensureDay();
  $('#tomorrowFree').checked = !!day.freeTomorrow;
  if (!day.items.length) {
    list.innerHTML = `<li class="empty-state">Plan today first. Your check-in awaits tonight.</li>`;
    return;
  }
  day.items.forEach((item, index) => {
    list.append(renderCheckinItem(item, index));
  });
}

function renderCheckinItem(item, index) {
  const li = document.createElement('li');
  li.dataset.index = String(index);
  const reasonSectionHidden = !item.status || item.status === 'success';
  const sliderHidden = item.status !== 'partial';
  const sliderValue = item.partial || 50;
  const options = Array.from(new Set([...(DEFAULT_REASONS[item.status] || []), ...(item.reasons || [])]));

  const header = document.createElement('div');
  const title = document.createElement('strong');
  title.textContent = item.title;
  header.append(title);
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  if (item.start) {
    const start = document.createElement('span');
    start.className = 'badge';
    start.textContent = item.start;
    meta.append(start);
  }
  const duration = document.createElement('span');
  duration.className = 'badge';
  duration.textContent = `${item.duration} min`;
  meta.append(duration);
  header.append(meta);
  li.append(header);

  const statusButtons = document.createElement('div');
  statusButtons.className = 'status-buttons';
  statusButtons.setAttribute('role', 'group');
  statusButtons.setAttribute('aria-label', `Status for ${item.title}`);
  ['success', 'partial', 'not_yet', 'skipped'].forEach((status) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'status-button';
    if (item.status === status) btn.classList.add('active');
    btn.dataset.status = status;
    btn.textContent = statusLabel(status);
    statusButtons.append(btn);
  });
  li.append(statusButtons);

  const reasonSection = document.createElement('div');
  reasonSection.className = `reason-section${reasonSectionHidden ? ' hidden' : ''}`;
  reasonSection.dataset.role = 'reason-section';
  const chipWrap = document.createElement('div');
  chipWrap.className = 'chips';
  chipWrap.dataset.role = 'reasons';
  options.forEach((reason) => {
    if (!reason) return;
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip';
    if (item.reasons?.includes(reason)) chip.classList.add('selected');
    chip.dataset.reason = reason;
    chip.textContent = reason;
    chipWrap.append(chip);
  });
  reasonSection.append(chipWrap);

  const addReason = document.createElement('button');
  addReason.type = 'button';
  addReason.className = 'chip';
  addReason.dataset.action = 'add-reason';
  addReason.textContent = '+ Add reason';
  reasonSection.append(addReason);

  const sliderWrap = document.createElement('div');
  sliderWrap.className = `slider-wrap${sliderHidden ? ' hidden' : ''}`;
  sliderWrap.dataset.role = 'slider-wrap';
  const sliderLabel = document.createElement('span');
  sliderLabel.className = 'label';
  const sliderValueEl = document.createElement('strong');
  sliderValueEl.dataset.role = 'slider-value';
  sliderValueEl.textContent = `${sliderValue}%`;
  sliderLabel.append('Partial progress: ', sliderValueEl);
  sliderWrap.append(sliderLabel);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '10';
  slider.max = '100';
  slider.step = '10';
  slider.value = String(sliderValue);
  slider.dataset.role = 'partial-slider';
  sliderWrap.append(slider);
  reasonSection.append(sliderWrap);

  const reflection = buildReflectionWorkspace(item, index);
  reasonSection.append(reflection);

  li.append(reasonSection);
  return li;
}

function buildReflectionWorkspace(item, index) {
  const wrap = document.createElement('div');
  wrap.className = 'reflection-workspace';
  const header = document.createElement('div');
  header.className = 'reflection-header';
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = 'Guided reflection';
  const actions = document.createElement('div');
  actions.className = 'reflection-actions';

  const prompts = getReflectionPrompts(item, index);
  wrap.dataset.prompts = prompts.join('||');
  wrap.dataset.promptIndex = '0';

  const prompt = document.createElement('span');
  prompt.className = 'reflection-prompt';
  prompt.dataset.role = 'reflection-prompt';
  prompt.textContent = prompts[0];

  const nextPromptBtn = document.createElement('button');
  nextPromptBtn.type = 'button';
  nextPromptBtn.dataset.action = 'prompt-next';
  nextPromptBtn.dataset.index = index;
  nextPromptBtn.textContent = 'Try another prompt';

  const dictateBtn = document.createElement('button');
  dictateBtn.type = 'button';
  dictateBtn.dataset.action = 'dictate';
  dictateBtn.dataset.index = index;
  dictateBtn.textContent = '🎙️ Dictate';

  const summarizeBtn = document.createElement('button');
  summarizeBtn.type = 'button';
  summarizeBtn.dataset.action = 'summarize';
  summarizeBtn.dataset.index = index;
  summarizeBtn.textContent = 'AI summary';

  actions.append(nextPromptBtn, dictateBtn, summarizeBtn);
  header.append(label, actions);

  const textarea = document.createElement('textarea');
  textarea.className = 'note';
  textarea.dataset.role = 'note';
  textarea.placeholder = prompts[0];
  textarea.value = item.note || '';

  const summary = document.createElement('div');
  summary.className = 'reflection-summary muted';
  summary.dataset.role = 'reflection-summary';
  summary.textContent = item.note ? generateSummaryFromText(item.note, item) : 'Your summary will appear here after you reflect.';

  wrap.append(header, prompt, textarea, summary);
  return wrap;
}

function getReflectionPrompts(item, index) {
  const prompts = [];
  const history = state.days
    .flatMap((day) => day.items || [])
    .filter((entry) => entry.taskId && entry.taskId === item.taskId);
  const successCount = history.filter((entry) => entry.status === 'success').length;
  if (item.status === 'success') {
    prompts.push('What made this session work so well?');
    prompts.push('Which habit would you repeat tomorrow?');
  } else if (item.status === 'partial') {
    prompts.push('Where did momentum fade and what nudged it forward?');
    prompts.push('What support would have turned this into a full win?');
  } else {
    prompts.push('What blocked progress and how might you unblock it?');
    prompts.push('Which micro-step could you schedule next?');
  }
  if (successCount >= 3) {
    prompts.push('How does this compare to past wins?');
  }
  if (!prompts.length) {
    prompts.push('Capture a quick reflection.');
  }
  return prompts;
}

function generateSummaryFromText(text, item) {
  if (!text) return '';
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const first = sentences[0] || text;
  const last = sentences.length > 1 ? sentences[sentences.length - 1] : '';
  const statusLabelText = statusLabel(item.status || 'success');
  const insights = [first];
  if (last && last !== first) insights.push(last);
  return `${statusLabelText} takeaway: ${insights.join(' • ')}`;
}

function cycleReflectionPrompt(index) {
  const row = $('#checkinList').querySelector(`li[data-index="${index}"]`);
  if (!row) return;
  const workspace = $('.reflection-workspace', row);
  if (!workspace) return;
  const prompts = (workspace.dataset.prompts || '').split('||').filter(Boolean);
  if (!prompts.length) return;
  const current = Number(workspace.dataset.promptIndex || '0');
  const nextIndex = (current + 1) % prompts.length;
  workspace.dataset.promptIndex = String(nextIndex);
  const promptEl = $('[data-role="reflection-prompt"]', workspace);
  if (promptEl) promptEl.textContent = prompts[nextIndex];
  const textarea = workspace.querySelector('[data-role="note"]');
  if (textarea && !textarea.value) {
    textarea.placeholder = prompts[nextIndex];
  }
}

function startDictation(index) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert('Voice dictation is not supported in this browser.');
    return;
  }
  const row = $('#checkinList').querySelector(`li[data-index="${index}"]`);
  if (!row) return;
  const textarea = row.querySelector('[data-role="note"]');
  if (!textarea) return;
  if (activeRecognition) {
    activeRecognition.stop();
  }
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = false;
  recognition.lang = navigator.language || 'en-US';
  recognition.onresult = (event) => {
    const transcript = Array.from(event.results)
      .map((result) => result[0].transcript)
      .join(' ');
    textarea.value = `${textarea.value ? `${textarea.value.trim()} ` : ''}${transcript}`.trim();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
    const day = ensureDay();
    const item = day.items[index];
    if (item) {
      item.note = textarea.value;
      saveState();
      updateReflectionSummary(row, item);
    }
  };
  recognition.onerror = (event) => {
    console.warn('Dictation error', event.error);
    toast('Dictation stopped.');
  };
  recognition.onend = () => {
    activeRecognition = null;
  };
  activeRecognition = recognition;
  recognition.start();
  toast('Listening... speak to capture your reflection.');
}

function summarizeReflection(index) {
  const row = $('#checkinList').querySelector(`li[data-index="${index}"]`);
  if (!row) return;
  const textarea = row.querySelector('[data-role="note"]');
  if (!textarea || !textarea.value.trim()) {
    toast('Add a few thoughts before requesting a summary.');
    return;
  }
  const day = ensureDay();
  const item = day.items[index];
  if (!item) return;
  const summary = generateSummaryFromText(textarea.value.trim(), item);
  const summaryEl = $('[data-role="reflection-summary"]', row);
  if (summaryEl) {
    summaryEl.textContent = summary;
    summaryEl.classList.remove('muted');
  }
  toast('Summary refreshed.');
}

function updateReflectionSummary(row, item) {
  const summaryEl = $('[data-role="reflection-summary"]', row);
  if (!summaryEl) return;
  if (!item.note) {
    summaryEl.textContent = 'Your summary will appear here after you reflect.';
    summaryEl.classList.add('muted');
    return;
  }
  summaryEl.textContent = generateSummaryFromText(item.note, item);
  summaryEl.classList.remove('muted');
}

function statusLabel(status) {
  switch (status) {
    case 'success':
      return 'Success';
    case 'partial':
      return 'Partial';
    case 'not_yet':
      return 'Not yet';
    case 'skipped':
      return 'Skipped';
    default:
      return status;
  }
}

function renderReview() {
  // Weekly review highlights successes, blockers, and streak momentum.
  const lastSeven = [...state.days]
    .filter((day) => day.items?.length)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 7);

  const dailyList = $('#dailySuccessList');
  dailyList.innerHTML = '';
  if (!lastSeven.length) {
    dailyList.innerHTML = '<li class="empty-state">Complete a few check-ins to see trends.</li>';
  } else {
    lastSeven.forEach((day) => {
      const { weighted, total } = calculateCompletion(day.items);
      const percent = total ? Math.round((weighted / total) * 100) : 0;
      const li = document.createElement('li');
      li.className = 'stat-item';
      const dayLabel = document.createElement('span');
      dayLabel.textContent = formatDate(day.date);
      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('span');
      fill.style.width = `${percent}%`;
      bar.append(fill);
      const pct = document.createElement('span');
      pct.textContent = `${percent}%`;
      li.append(dayLabel, bar, pct);
      dailyList.append(li);
    });
  }

  const reasonCounts = new Map();
  lastSeven.forEach((day) => {
    day.items.forEach((item) => {
      if (item.status === 'success') return;
      (item.reasons || []).forEach((reason) => {
        if (!reason) return;
        reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
      });
    });
  });
  const reasonList = $('#topReasonsList');
  reasonList.innerHTML = '';
  if (!reasonCounts.size) {
    reasonList.innerHTML = '<li class="empty-state">No reasons logged yet. Add them during check-in.</li>';
  } else {
    Array.from(reasonCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .forEach(([reason, count]) => {
        const li = document.createElement('li');
        li.className = 'stat-item';
        const label = document.createElement('span');
        label.textContent = reason;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = String(count);
        li.append(label, badge);
        reasonList.append(li);
      });
  }

  const streakSummary = $('#streakSummary');
  streakSummary.innerHTML = '';
  const history = state.streakHistory.slice(-5).reverse();
  if (!history.length) {
    streakSummary.innerHTML = '<div class="empty-state">Complete check-ins to build your streak story.</div>';
  } else {
    history.forEach((row) => {
      const div = document.createElement('div');
      div.className = 'streak-row';
      const label = document.createElement('span');
      label.textContent = formatDate(row.date);
      const streak = document.createElement('strong');
      streak.textContent = `${row.streak} 🔥`;
      div.append(label, streak);
      streakSummary.append(div);
    });
  }

  renderPredictiveAnalytics(lastSeven);
  renderCoachTips();
  renderAnomalyAlerts(lastSeven);
  renderSignalCorrelations();
  renderFocusDrift(lastSeven);
}

function renderPredictiveAnalytics(lastSeven) {
  const list = $('#predictiveList');
  if (!list) return;
  list.innerHTML = '';
  if (lastSeven.length < 3) {
    list.innerHTML = '<li class="empty-state">Log a few more check-ins for forecasts.</li>';
    return;
  }
  const ratios = lastSeven
    .slice()
    .reverse()
    .map((day) => {
      const { weighted, total } = calculateCompletion(day.items);
      return total ? weighted / total : 0;
    });
  const weights = ratios.map((_, index) => index + 1);
  const forecast =
    ratios.reduce((sum, ratio, index) => sum + ratio * weights[index], 0) / weights.reduce((a, b) => a + b, 0);
  const forecastPct = Math.round(forecast * 100);
  const recentSignals = state.metrics.signals.slice(-7);
  const energyTrend = recentSignals.length
    ? recentSignals.reduce((sum, entry) => sum + (entry.energy || 0), 0) / recentSignals.length
    : 0;

  const liForecast = document.createElement('li');
  liForecast.className = 'stat-item';
  liForecast.innerHTML = `<span>Projected success rate</span><strong>${forecastPct}%</strong>`;
  const liEnergy = document.createElement('li');
  liEnergy.className = 'stat-item';
  liEnergy.innerHTML = `<span>Energy trend</span><strong>${energyTrend ? energyTrend.toFixed(1) : '—'}</strong>`;
  list.append(liForecast, liEnergy);
}

function renderCoachTips() {
  const list = $('#coachTipsList');
  if (!list) return;
  list.innerHTML = '';
  const tips = state.coach?.insights || [];
  if (!tips.length) {
    list.innerHTML = '<li class="empty-state">Insights appear once you submit a check-in.</li>';
    return;
  }
  tips.forEach((tip) => {
    const li = document.createElement('li');
    li.className = 'stat-item';
    li.textContent = tip;
    list.append(li);
  });
}

function renderAnomalyAlerts(lastSeven) {
  const list = $('#anomalyList');
  if (!list) return;
  list.innerHTML = '';
  if (!lastSeven.length) {
    list.innerHTML = '<li class="empty-state">No check-ins yet.</li>';
    return;
  }
  const ratios = lastSeven.map((day) => {
    const { weighted, total } = calculateCompletion(day.items);
    return total ? weighted / total : 0;
  });
  const average = ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length;
  const anomalies = lastSeven.filter((_, index) => Math.abs(ratios[index] - average) > 0.2);
  if (!anomalies.length) {
    list.innerHTML = '<li class="empty-state">No anomalies detected this week.</li>';
    return;
  }
  anomalies.forEach((day) => {
    const { weighted, total } = calculateCompletion(day.items);
    const percent = total ? Math.round((weighted / total) * 100) : 0;
    const li = document.createElement('li');
    li.className = 'stat-item';
    li.innerHTML = `<span>${formatDate(day.date)}</span><strong>${percent}%</strong>`;
    list.append(li);
  });
}

function renderSignalCorrelations() {
  const list = $('#signalCorrelationList');
  if (!list) return;
  list.innerHTML = '';
  const signals = state.metrics.signals.slice(-14);
  if (!signals.length) {
    list.innerHTML = '<li class="empty-state">Log energy or mood to see correlations.</li>';
    return;
  }
  const byEnergy = new Map();
  signals.forEach((entry) => {
    if (typeof entry.ratio !== 'number') return;
    const key = ENERGY_LABELS[entry.energy] || `Level ${entry.energy}`;
    const bucket = byEnergy.get(key) || [];
    bucket.push(entry.ratio);
    byEnergy.set(key, bucket);
  });
  Array.from(byEnergy.entries())
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
    .forEach(([key, ratios]) => {
      const avg = Math.round((ratios.reduce((sum, ratio) => sum + ratio, 0) / ratios.length) * 100);
      const li = document.createElement('li');
      li.className = 'stat-item';
      li.innerHTML = `<span>${key}</span><strong>${avg}% success</strong>`;
      list.append(li);
    });
}

function renderFocusDrift(lastSeven) {
  const list = $('#focusDriftList');
  if (!list) return;
  list.innerHTML = '';
  if (!lastSeven.length) {
    list.innerHTML = '<li class="empty-state">Log focus sessions to compare against the plan.</li>';
    return;
  }
  lastSeven.forEach((day) => {
    const planned = day.items.reduce((sum, item) => sum + (item.duration || 0), 0);
    const actual = state.metrics.focusSessions
      .filter((session) => session.date === day.date)
      .reduce((sum, session) => sum + (session.minutes || 0), 0);
    const delta = Math.round(actual - planned);
    const li = document.createElement('li');
    li.className = 'stat-item';
    const trend = delta === 0 ? 'on plan' : delta > 0 ? `+${delta} min` : `${delta} min`;
    li.innerHTML = `<span>${formatDate(day.date)}</span><strong>${Math.round(actual)} / ${planned} (${trend})</strong>`;
    list.append(li);
  });
}

function formatDate(dateKey) {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

function makeGCalLink(item) {
  const startDate = new Date();
  const [hours, minutes] = (item.start || '08:00').split(':');
  startDate.setHours(Number(hours), Number(minutes), 0, 0);
  const end = new Date(startDate.getTime() + (item.duration || 30) * 60000);
  const fmt = (date) => date.toISOString().replace(/[-:]|\.\d{3}/g, '');
  const details = encodeURIComponent('Planned with GatePlan');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(item.title)}&dates=${fmt(startDate)}/${fmt(end)}&details=${details}`;
}

function addToToday() {
  const day = ensureDay();
  const taskId = $('#planTaskSelect').value;
  if (!taskId) {
    alert('Add tasks to your pool first.');
    return;
  }
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) {
    alert('Task not found in pool.');
    return;
  }
  const duration = Number($('#planDuration').value) || task.defDur || 30;
  const newItem = normalizeItem({
    id: crypto.randomUUID(),
    taskId: task.id,
    title: task.title,
    start: $('#planStartTime').value || null,
    duration,
    status: null,
    partial: 0,
    reasons: [],
    note: '',
  });
  day.items.push(newItem);
  $('#planDuration').value = '';
  saveState();
  renderTodayViews();
  renderCheckinList();
  maybeShowGate();
}

function finishPlanning() {
  const day = ensureDay();
  if (day.items.length < state.settings.minTasks) {
    alert(`Please plan at least ${state.settings.minTasks} task${state.settings.minTasks === 1 ? '' : 's'} before unlocking the day.`);
    return;
  }
  day.planned = true;
  day.checked = false;
  day.freeTomorrow = false;
  saveState();
  maybeShowGate();
  toast('Plan locked in. Have a focused day!');
}

function handleCheckinListClick(event) {
  const li = event.target.closest('li[data-index]');
  if (!li) return;
  const index = Number(li.dataset.index);
  const day = ensureDay();
  const item = day.items[index];
  if (!item) return;

  const statusBtn = event.target.closest('.status-button');
  if (statusBtn) {
    const status = statusBtn.dataset.status;
    item.status = status;
    if (status === 'success') {
      item.reasons = [];
      item.partial = 100;
    } else if (status === 'partial') {
      item.partial = item.partial || 50;
    } else {
      item.partial = 0;
    }
    saveState();
    replaceCheckinItem(index);
    renderTodayLiveList();
    return;
  }

  const chip = event.target.closest('.chip[data-reason]');
  if (chip) {
    const reason = chip.dataset.reason;
    if (item.reasons?.includes(reason)) {
      item.reasons = item.reasons.filter((r) => r !== reason);
    } else {
      item.reasons = [...(item.reasons || []), reason];
    }
    saveState();
    replaceCheckinItem(index);
    return;
  }

  const addReason = event.target.closest('[data-action="add-reason"]');
  if (addReason) {
    const userReason = prompt('Add a quick reason');
    if (userReason) {
      item.reasons = [...(item.reasons || []), userReason.trim()];
      saveState();
      replaceCheckinItem(index);
    }
    return;
  }

  const dictationBtn = event.target.closest('[data-action="dictate"]');
  if (dictationBtn) {
    startDictation(index);
    return;
  }

  const summaryBtn = event.target.closest('[data-action="summarize"]');
  if (summaryBtn) {
    summarizeReflection(index);
    return;
  }

  const promptBtn = event.target.closest('[data-action="prompt-next"]');
  if (promptBtn) {
    cycleReflectionPrompt(index);
  }
}

function handleCheckinListInput(event) {
  const li = event.target.closest('li[data-index]');
  if (!li) return;
  const index = Number(li.dataset.index);
  const day = ensureDay();
  const item = day.items[index];
  if (!item) return;

  if (event.target.matches('[data-role="partial-slider"]')) {
    const value = Number(event.target.value);
    item.partial = value;
    item.status = 'partial';
    saveState();
    const row = $('#checkinList').querySelector(`li[data-index="${index}"]`);
    if (row) {
      const label = $('[data-role="slider-value"]', row);
      if (label) label.textContent = `${value}%`;
      $$('.status-button', row).forEach((btn) => {
        btn.classList.toggle('active', btn.dataset.status === 'partial');
      });
      $('[data-role="reason-section"]', row)?.classList.remove('hidden');
      $('[data-role="slider-wrap"]', row)?.classList.remove('hidden');
    }
    renderTodayLiveList();
    return;
  }

  if (event.target.matches('[data-role="note"]')) {
    item.note = event.target.value;
    saveState();
    renderTodayLiveList();
    const row = $('#checkinList').querySelector(`li[data-index="${index}"]`);
    if (row) updateReflectionSummary(row, item);
  }
}

function updateEnergyLabel() {
  const slider = $('#energyLevel');
  if (!slider) return;
  const label = $('#energyLabel');
  const value = clamp(Number(slider.value) || 3, 1, 5);
  if (label) {
    label.textContent = ENERGY_LABELS[value];
  }
}

function logDailySignals(day, ratio) {
  const energy = clamp(Number($('#energyLevel').value) || 3, 1, 5);
  const mood = $('#moodState').value || 'steady';
  const biometrics = $('#biometricInput').value.trim();
  const entry = { date: day.date, energy, mood, biometrics, ratio };
  const existingIndex = state.metrics.signals.findIndex((signal) => signal.date === day.date);
  if (existingIndex >= 0) {
    state.metrics.signals.splice(existingIndex, 1, entry);
  } else {
    state.metrics.signals.push(entry);
  }
  state.metrics.signals = state.metrics.signals.slice(-90);
}

function renderSignalInsight() {
  const insight = $('#signalInsight');
  if (!insight) return;
  const latest = state.metrics.signals.slice(-1)[0];
  if (!latest || latest.date !== todayKey()) {
    insight.textContent = '';
    return;
  }
  const ratioText = typeof latest.ratio === 'number' ? `${Math.round(latest.ratio * 100)}%` : '—';
  const energyLabel = ENERGY_LABELS[latest.energy] || 'Balanced';
  insight.textContent = `Today’s signals • Energy ${energyLabel}, mood ${latest.mood}. Outcome: ${ratioText}.`;
}

function updateGamificationProgress(day, ratio) {
  const xpGain = Math.round(Math.max(20, ratio * 120));
  state.gamification.xp = (state.gamification.xp || 0) + xpGain;
  state.gamification.level = calculateLevel(state.gamification.xp);

  if (ratio >= 0.99 && !day.freeTomorrow) {
    ensureBadge('perfect-day', 'Perfect day', 'Logged a 100% success reflection.');
  }
  if (state.streak >= 7) {
    ensureBadge('streak-7', 'Streak keeper', 'Held a streak for seven days.');
  }

  const focusToday = state.metrics.focusSessions
    .filter((session) => session.date === day.date)
    .reduce((sum, session) => sum + (session.minutes || 0), 0);
  if (focusToday >= 90) {
    ensureBadge('focus-90', 'Focus builder', 'Logged 90 minutes of focus in a day.');
  }

  state.gamification.seasonalChallenges = (state.gamification.seasonalChallenges || defaultSeasonalChallenges()).map(
    (challenge) => {
      if (challenge.id === 'streak-surge') {
        const progress = day.freeTomorrow ? challenge.progress : Math.min(challenge.goal, state.streak);
        return { ...challenge, progress };
      }
      return challenge;
    }
  );
}

function calculateLevel(xp) {
  return Math.max(1, Math.floor(xp / 500) + 1);
}

function ensureBadge(id, title, description) {
  const badges = state.gamification.badges || [];
  if (badges.some((badge) => badge.id === id)) return;
  badges.push({ id, title, description, earnedAt: new Date().toISOString() });
  state.gamification.badges = badges.slice(-20);
}

function renderGamification() {
  const container = $('#gamificationSummary');
  if (!container) return;
  const levelBadge = $('#gamificationLevel');
  if (levelBadge) {
    levelBadge.textContent = `Lvl ${state.gamification.level || 1}`;
  }
  const xp = state.gamification.xp || 0;
  const level = state.gamification.level || calculateLevel(xp);
  const nextLevelXp = level * 500;
  const progress = Math.min(1, xp / nextLevelXp);
  const badges = state.gamification.badges || [];
  const challenges = state.gamification.seasonalChallenges || [];

  container.innerHTML = '';
  const progressRow = document.createElement('div');
  progressRow.className = 'gamification-progress';
  progressRow.innerHTML = `XP ${xp} / ${nextLevelXp}`;
  const bar = document.createElement('div');
  bar.className = 'progress-track';
  const fill = document.createElement('div');
  fill.className = 'progress-fill';
  fill.style.width = `${Math.round(progress * 100)}%`;
  bar.append(fill);
  progressRow.append(bar);
  container.append(progressRow);

  const badgeWrap = document.createElement('div');
  badgeWrap.className = 'badge-wrap';
  if (!badges.length) {
    badgeWrap.innerHTML = '<p class="muted">No badges yet. Consistency unlocks surprises.</p>';
  } else {
    const list = document.createElement('ul');
    list.className = 'inline-list';
    badges.slice(-5).reverse().forEach((badge) => {
      const li = document.createElement('li');
      li.textContent = `🏅 ${badge.title}`;
      list.append(li);
    });
    badgeWrap.append(list);
  }
  container.append(badgeWrap);

  const challengeWrap = document.createElement('div');
  challengeWrap.className = 'challenge-wrap';
  if (!challenges.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Seasonal challenges will appear here once you start logging focus.';
    challengeWrap.append(empty);
  } else {
    challenges.forEach((challenge) => {
      const row = document.createElement('div');
      row.className = 'challenge-row';
      const title = document.createElement('strong');
      title.textContent = challenge.title;
      const progressTrack = document.createElement('div');
      progressTrack.className = 'progress-track';
      const progressFill = document.createElement('div');
      progressFill.className = 'progress-fill';
      const pct = Math.min(1, (challenge.progress || 0) / challenge.goal);
      progressFill.style.width = `${Math.round(pct * 100)}%`;
      progressTrack.append(progressFill);
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = `${challenge.progress || 0}/${challenge.goal}`;
      row.append(title, progressTrack, meta);
      challengeWrap.append(row);
    });
  }
  container.append(challengeWrap);
}

function replaceCheckinItem(index) {
  const list = $('#checkinList');
  const row = list.querySelector(`li[data-index="${index}"]`);
  if (!row) return;
  const day = ensureDay();
  const updated = renderCheckinItem(day.items[index], index);
  row.replaceWith(updated);
}

function submitCheckin() {
  const day = ensureDay();
  if (!day.items.length) {
    alert('Nothing planned. Add tasks first.');
    return;
  }
  for (const item of day.items) {
    if (!item.status) {
      alert(`Please select a status for "${item.title}".`);
      return;
    }
    if ((item.status === 'not_yet' || item.status === 'skipped') && (!item.reasons?.length && !item.note?.trim())) {
      alert(`Add at least one reason or a note for "${item.title}".`);
      return;
    }
  }

  const { weighted, total } = calculateCompletion(day.items);
  const ratio = total ? weighted / total : 0;
  day.checked = true;
  day.freeTomorrow = $('#tomorrowFree').checked;
  day.summary = { weighted, total, ratio, completedAt: new Date().toISOString() };
  state.lastCheckinDate = todayKey();

  const threshold = state.settings.streakThreshold || DEFAULT_SETTINGS.streakThreshold;
  const qualifies = day.freeTomorrow || ratio >= threshold;
  logDailySignals(day, ratio);
  updateCoachInsights(day, ratio);
  updateGamificationProgress(day, ratio);
  if (qualifies) {
    state.streak += 1;
    state.bestStreak = Math.max(state.bestStreak, state.streak);
  } else {
    state.streak = 0;
  }
  state.streakHistory.push({ date: state.lastCheckinDate, streak: state.streak });
  state.streakHistory = state.streakHistory.slice(-120);

  saveState();
  renderDateInfo();
  renderTodayViews();
  renderReview();
  renderGamification();
  renderSignalInsight();
  $('#checkinResult').textContent = qualifies
    ? `Great reflection! ${Math.round(ratio * 100)}% success keeps the streak alive.`
    : `Logged. ${Math.round(ratio * 100)}% — tomorrow is a fresh start.`;

  if (qualifies) {
    launchConfetti();
  }

  maybeAutoReshuffle();
}

function toast(message) {
  $('#checkinResult').textContent = message;
}

function maybeShowGate() {
  const overlay = $('#gate');
  const day = ensureDay();
  const [hour, minute] = (state.settings.morningHour || '07:00').split(':').map(Number);
  const now = new Date();
  const gateTime = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute || 0, 0);
  const needsPlan = day.items.length < state.settings.minTasks || !day.planned;
  const shouldShow = now >= gateTime && needsPlan && !day.checked;
  overlay.classList.toggle('hidden', !shouldShow);
  overlay.setAttribute('aria-hidden', shouldShow ? 'false' : 'true');
  $('#minTaskRequirement').textContent = `${state.settings.minTasks} task${state.settings.minTasks === 1 ? '' : 's'}`;
}

function setTab(tabId) {
  $$('.tab-button').forEach((btn) => {
    const active = btn.id === `tab-${tabId}`;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  $$('.view').forEach((view) => {
    view.classList.toggle('visible', view.id === `view-${tabId}`);
  });
  if (tabId === 'review') {
    renderReview();
  }
}

function applySettingsToUI() {
  $('#morningHour').value = state.settings.morningHour;
  $('#minTasks').value = state.settings.minTasks;
  $('#calLinks').value = state.settings.calLinks;
  $('#streakThreshold').value = String(state.settings.streakThreshold);
  $('#themeChoice').value = state.settings.theme;
  $('#accentColor').value = state.settings.accentColor;
  $('#autoReshuffle').value = state.settings.autoReshuffle;
  $('#pomodoroLength').value = state.settings.pomodoroLength;
  $('#shortBreakLength').value = state.settings.shortBreakLength;
  $('#longBreakLength').value = state.settings.longBreakLength;
}

function updateSettings() {
  state.settings.morningHour = $('#morningHour').value || DEFAULT_SETTINGS.morningHour;
  state.settings.minTasks = clamp(Number($('#minTasks').value) || DEFAULT_SETTINGS.minTasks, 1, 20);
  state.settings.calLinks = $('#calLinks').value;
  state.settings.streakThreshold = Number($('#streakThreshold').value) || DEFAULT_SETTINGS.streakThreshold;
  state.settings.theme = $('#themeChoice').value;
  state.settings.accentColor = $('#accentColor').value || DEFAULT_SETTINGS.accentColor;
  state.settings.autoReshuffle = $('#autoReshuffle').value || DEFAULT_SETTINGS.autoReshuffle;
  state.settings.pomodoroLength = clamp(Number($('#pomodoroLength').value) || DEFAULT_SETTINGS.pomodoroLength, 10, 60);
  state.settings.shortBreakLength = clamp(Number($('#shortBreakLength').value) || DEFAULT_SETTINGS.shortBreakLength, 3, 20);
  state.settings.longBreakLength = clamp(Number($('#longBreakLength').value) || DEFAULT_SETTINGS.longBreakLength, 5, 30);
  saveState();
  applyTheme();
  updateFocusTimerModeLabel();
  maybeShowGate();
  renderTodayViews();
  toast('Settings saved.');
}

function applyTheme() {
  const root = document.documentElement;
  let theme = state.settings.theme;
  if (theme === 'system') {
    theme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  root.dataset.theme = theme;
  root.style.setProperty('--accent', state.settings.accentColor);
  root.style.setProperty('--accent-soft', hexToRgba(state.settings.accentColor, 0.15));
}

function hexToRgba(hex, alpha) {
  const parsed = hex.replace('#', '');
  if (parsed.length !== 6) return `rgba(99,102,241,${alpha})`;
  const bigint = parseInt(parsed, 16);
  const r = (bigint >> 16) & 255;
  const g = (bigint >> 8) & 255;
  const b = bigint & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function updateOfflineBanner() {
  // Provide immediate visual feedback for offline/online transitions.
  const banner = $('#offlineBanner');
  if (!navigator.onLine) {
    banner.classList.add('active');
    $('#offlineText').textContent = `Offline mode: ${pendingSyncCount} item${pendingSyncCount === 1 ? '' : 's'} queued`;
  } else {
    banner.classList.remove('active');
    const suffix = pendingSyncCount ? `syncing ${pendingSyncCount}` : 'synced';
    $('#offlineText').textContent = `Back online • ${suffix}`;
  }
}

function handleSWMessage(event) {
  if (!event?.data) return;
  if (event.data.type === 'sync-status') {
    pendingSyncCount = event.data.pending || 0;
    updateOfflineBanner();
  }
  if (event.data.type === 'push-reminder') {
    toast(event.data.message);
  }
}

function initServiceWorkerMessaging() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', handleSWMessage);
  navigator.serviceWorker.ready
    .then((registration) => {
      registration.active?.postMessage({ type: 'sync-status' });
    })
    .catch(() => {
      /* ignore */
    });
  setInterval(() => {
    navigator.serviceWorker.controller?.postMessage({ type: 'sync-status' });
  }, 30000);
}

function exportData() {
  try {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gateplan-backup-${todayKey()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  } catch (error) {
    alert('Unable to export data.');
    console.error(error);
  }
}

function importData(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      // Resilient backup restore with migration to the latest schema.
      const parsed = JSON.parse(event.target.result);
      state = migrateState(parsed);
      ensureDay();
      ensureDemoTasks();
      saveState();
      hydrateUI();
      toast('Import complete. Welcome back!');
    } catch (error) {
      alert('Invalid backup file.');
      console.error('Import failed', error);
    }
  };
  reader.readAsText(file);
}

function launchConfetti() {
  // Lightweight celebration animation to reinforce streak wins.
  const canvas = $('#confettiCanvas');
  const ctx = canvas.getContext('2d');
  const pieces = Array.from({ length: 120 }, () => createConfettiPiece(canvas));
  let animationFrame;
  let start = null;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  resize();
  canvas.classList.remove('hidden');

  function step(timestamp) {
    if (!start) start = timestamp;
    const progress = timestamp - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    pieces.forEach((piece) => {
      piece.y += piece.speed;
      piece.x += Math.sin((progress / 200 + piece.drift) * piece.drift) * 2;
      if (piece.y > canvas.height) piece.y = -20;
      ctx.fillStyle = piece.color;
      ctx.fillRect(piece.x, piece.y, piece.size, piece.size * 0.6);
    });
    if (progress < 1800) {
      animationFrame = requestAnimationFrame(step);
    } else {
      canvas.classList.add('hidden');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      cancelAnimationFrame(animationFrame);
    }
  }

  animationFrame = requestAnimationFrame(step);
  setTimeout(() => {
    window.addEventListener('resize', resize, { once: true });
  }, 0);
}

function createConfettiPiece(canvas) {
  const colors = [state.settings.accentColor, '#f97316', '#22c55e', '#facc15'];
  return {
    x: Math.random() * canvas.width,
    y: Math.random() * canvas.height,
    size: Math.random() * 12 + 6,
    speed: Math.random() * 3 + 2,
    color: colors[Math.floor(Math.random() * colors.length)],
    drift: Math.random() * 2,
  };
}

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((err) => {
      console.warn('Service worker registration failed', err);
    });
  }
}

function initEventListeners() {
  $('#tab-plan').addEventListener('click', () => setTab('plan'));
  $('#tab-today').addEventListener('click', () => setTab('today'));
  $('#tab-pool').addEventListener('click', () => setTab('pool'));
  $('#tab-checkin').addEventListener('click', () => setTab('checkin'));
  $('#tab-review').addEventListener('click', () => setTab('review'));
  $('#tab-settings').addEventListener('click', () => setTab('settings'));

  $('#coachRefresh').addEventListener('click', () => refreshCoachSuggestions(true));
  $('#coachApply').addEventListener('click', applyCoachSuggestions);

  $('#addToToday').addEventListener('click', addToToday);
  $('#finishPlanning').addEventListener('click', finishPlanning);

  $('#addPoolTask').addEventListener('click', () => {
    const title = $('#poolTitle').value.trim();
    const defDur = Number($('#poolDuration').value) || 30;
    const due = $('#poolDue').value || null;
    const tags = $('#poolTags').value
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    if (!title) {
      alert('Please enter a title.');
      return;
    }
    state.tasks.push({ id: crypto.randomUUID(), title, defDur, due, tags });
    $('#poolForm').reset();
    saveState();
    renderTasks();
    renderTodayPlanList();
  });

  $('#saveSettings').addEventListener('click', updateSettings);

  $('#gateGo').addEventListener('click', () => {
    setTab('plan');
    $('#gate').classList.add('hidden');
  });

  $('#submitCheckin').addEventListener('click', submitCheckin);

  $('#energyLevel').addEventListener('input', updateEnergyLabel);

  $('#checkinList').addEventListener('click', handleCheckinListClick);
  $('#checkinList').addEventListener('input', handleCheckinListInput);

  $('#calendarImportBtn').addEventListener('click', () => $('#calendarImportFile').click());
  $('#calendarImportFile').addEventListener('change', (event) => {
    const [file] = event.target.files || [];
    handleCalendarImport(file);
    event.target.value = '';
  });
  $('#calendarAutoAdjust').addEventListener('click', autoAdjustPlanFromCalendar);

  $('#focusTimerStart').addEventListener('click', startFocusTimer);
  $('#focusTimerPause').addEventListener('click', pauseFocusTimer);
  $('#focusTimerReset').addEventListener('click', completeFocusTimer);
  $('#focusTimerTask').addEventListener('change', (event) => {
    focusTimerState.taskId = event.target.value;
  });

  window.addEventListener('focus', () => {
    renderDateInfo();
    maybeShowGate();
  });

  window.addEventListener('online', updateOfflineBanner);
  window.addEventListener('offline', updateOfflineBanner);

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $('#installBtn').classList.remove('hidden');
  });

  $('#installBtn').addEventListener('click', async () => {
    $('#installBtn').classList.add('hidden');
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
  });

  $('#exportData').addEventListener('click', exportData);
  $('#importData').addEventListener('click', () => $('#importFile').click());
  $('#importFile').addEventListener('change', (event) => {
    const [file] = event.target.files;
    importData(file);
    event.target.value = '';
  });
}

function init() {
  state = loadState();
  ensureDay();
  ensureDemoTasks();
  hydrateUI();
  initEventListeners();
  setTab('plan');
  registerSW();
  initServiceWorkerMessaging();
  updateEnergyLabel();
  updateFocusTimerModeLabel();
  updateFocusTimerDisplay();
}

document.addEventListener('DOMContentLoaded', init);
