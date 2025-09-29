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
};

let state = createInitialState();
let deferredInstallPrompt = null;

function createInitialState() {
  return {
    version: 2,
    tasks: [],
    days: [],
    streak: 0,
    bestStreak: 0,
    streakHistory: [],
    lastCheckinDate: null,
    settings: { ...DEFAULT_SETTINGS },
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
  } catch (error) {
    console.error('Unable to persist GatePlan state', error);
  }
}

function updateLastSync() {
  const stamp = new Date();
  $('#lastSync').textContent = `Last saved ${stamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
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
  renderTodayViews();
  renderCheckinList();
  renderReview();
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

function renderTodayViews() {
  renderTodayPlanList();
  renderTodayLiveList();
  updatePlanSummary();
  updateTodayProgress();
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

  const noteField = document.createElement('label');
  noteField.className = 'field';
  const noteLabel = document.createElement('span');
  noteLabel.className = 'label';
  noteLabel.textContent = 'Note (optional)';
  const textarea = document.createElement('textarea');
  textarea.className = 'note';
  textarea.dataset.role = 'note';
  textarea.placeholder = 'Capture insights';
  textarea.value = item.note || '';
  noteField.append(noteLabel, textarea);
  reasonSection.append(noteField);

  li.append(reasonSection);
  return li;
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
  }
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
  $('#checkinResult').textContent = qualifies
    ? `Great reflection! ${Math.round(ratio * 100)}% success keeps the streak alive.`
    : `Logged. ${Math.round(ratio * 100)}% — tomorrow is a fresh start.`;

  if (qualifies) {
    launchConfetti();
  }
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
}

function updateSettings() {
  state.settings.morningHour = $('#morningHour').value || DEFAULT_SETTINGS.morningHour;
  state.settings.minTasks = clamp(Number($('#minTasks').value) || DEFAULT_SETTINGS.minTasks, 1, 20);
  state.settings.calLinks = $('#calLinks').value;
  state.settings.streakThreshold = Number($('#streakThreshold').value) || DEFAULT_SETTINGS.streakThreshold;
  state.settings.theme = $('#themeChoice').value;
  state.settings.accentColor = $('#accentColor').value || DEFAULT_SETTINGS.accentColor;
  saveState();
  applyTheme();
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
    $('#offlineText').textContent = 'Offline mode: changes stored locally';
  } else {
    banner.classList.remove('active');
    $('#offlineText').textContent = 'Back online';
  }
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

  $('#checkinList').addEventListener('click', handleCheckinListClick);
  $('#checkinList').addEventListener('input', handleCheckinListInput);

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
}

document.addEventListener('DOMContentLoaded', init);
