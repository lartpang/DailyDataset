(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const results = $('results');
  const count = $('result-count');
  const search = $('search');
  const source = $('source');
  const numberFormat = new Intl.NumberFormat('zh-CN');
  let dateCounts = new Map();
  let dates = [];
  let currentDate = '';
  let currentPapers = [];
  let requestNumber = 0;
  let view = 'day';
  let scopeYear = 0;
  let scopeMonth = 0;

  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
  }

  function dateLabel(value) {
    const [year, month, day] = value.split('-');
    return `${year} 年 ${Number(month)} 月 ${Number(day)} 日`;
  }

  function setMessage(text, isError = false) {
    const message = document.createElement('div');
    message.className = `message${isError ? ' error' : ''}`;
    message.textContent = text;
    results.replaceChildren(message);
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderHeatmap() {
    if (!scopeYear || !scopeMonth) return;
    const today = new Date().toISOString().slice(0, 10);
    const yearPrefix = String(scopeYear);
    const monthPrefix = `${yearPrefix}-${String(scopeMonth).padStart(2, '0')}`;
    const yearly = new Map();
    const monthly = new Map();
    for (const [day, value] of dateCounts) {
      if (day > today) continue;
      const year = day.slice(0, 4);
      const month = day.slice(0, 7);
      yearly.set(year, (yearly.get(year) || 0) + value);
      monthly.set(month, (monthly.get(month) || 0) + value);
    }
    for (const granularity of ['year', 'month', 'day']) {
      $('view-' + granularity).setAttribute('aria-pressed', String(view === granularity));
    }
    $('heatmap-weekdays').hidden = view !== 'day';
    const grid = $('heatmap-grid');
    grid.className = `heatmap-grid ${view}-grid`;
    let cells = [];
    if (view === 'year') {
      cells = [...yearly.keys()].sort().map((year) => ({ key: year, label: `${year} 年`, count: yearly.get(year), active: year === yearPrefix }));
      $('heatmap-period').textContent = '所有归档年份';
      $('heatmap-context').textContent = '各年份论文发布总量';
      $('heatmap-hint').textContent = '选择年份查看各月';
    } else if (view === 'month') {
      cells = Array.from({ length: 12 }, (_, i) => {
        const key = `${yearPrefix}-${String(i + 1).padStart(2, '0')}`;
        return { key, label: `${i + 1} 月`, count: monthly.get(key) || 0, future: key > today.slice(0, 7), active: key === monthPrefix };
      });
      $('heatmap-period').textContent = `${scopeYear} 年 · ${numberFormat.format(yearly.get(yearPrefix) || 0)} 篇`;
      $('heatmap-context').textContent = '当前年份各月份论文发布量';
      $('heatmap-hint').textContent = '选择月份查看每日';
    } else {
      const daysInMonth = new Date(Date.UTC(scopeYear, scopeMonth, 0)).getUTCDate();
      cells = Array.from({ length: daysInMonth }, (_, i) => {
        const key = `${monthPrefix}-${String(i + 1).padStart(2, '0')}`;
        return { key, label: String(i + 1), count: dateCounts.get(key) || 0, future: key > today, active: key === currentDate };
      });
      $('heatmap-period').textContent = `${scopeYear} 年 ${scopeMonth} 月 · ${numberFormat.format(monthly.get(monthPrefix) || 0)} 篇`;
      $('heatmap-context').textContent = '当前月份每日论文发布量';
      $('heatmap-hint').textContent = '选择日期查看当天论文';
    }
    const max = Math.max(0, ...cells.filter((cell) => !cell.future).map((cell) => cell.count));
    const nodes = [];
    if (view === 'day') {
      const weekday = new Date(Date.UTC(scopeYear, scopeMonth - 1, 1)).getUTCDay();
      const leading = (weekday + 6) % 7;
      for (let i = 0; i < leading; i++) {
        const spacer = element('span', 'heat-spacer');
        spacer.setAttribute('aria-hidden', 'true');
        nodes.push(spacer);
      }
    }
    for (const cell of cells) {
      const level = cell.count && max ? Math.max(1, Math.ceil(cell.count / max * 4)) : 0;
      const button = element('button', `heat-cell level-${level}${cell.active ? ' active' : ''}${cell.future ? ' future' : ''}`);
      button.type = 'button';
      button.disabled = !!cell.future;
      button.dataset.value = cell.key;
      button.setAttribute('aria-label', cell.future ? `${cell.label}，未来日期` : `${cell.label}，${numberFormat.format(cell.count)} 篇论文`);
      button.setAttribute('aria-pressed', String(!!cell.active));
      button.append(element('span', 'heat-label', cell.label), element('strong', 'heat-count', cell.future ? '' : numberFormat.format(cell.count)));
      button.addEventListener('click', () => {
        if (view === 'year') {
          scopeYear = Number(cell.key);
          if (scopeYear === Number(today.slice(0, 4))) scopeMonth = Math.min(scopeMonth, Number(today.slice(5, 7)));
          view = 'month';
          renderHeatmap();
        } else if (view === 'month') {
          scopeMonth = Number(cell.key.slice(5, 7));
          view = 'day';
          renderHeatmap();
        } else {
          selectDate(cell.key);
        }
      });
      nodes.push(button);
    }
    grid.replaceChildren(...nodes);
  }

  function paperCard(paper, index) {
    const article = element('article', 'paper');
    const ordinal = element('div', 'paper-number', String(index + 1).padStart(2, '0'));
    ordinal.setAttribute('aria-hidden', 'true');
    const content = element('div', 'paper-content');
    const meta = element('div', 'paper-top');
    meta.append(element('span', `badge${paper.source === 'Preprints.org' ? ' preprints' : ''}`, paper.source), element('span', 'paper-date', paper.date));
    const heading = element('h4', 'paper-title');
    try {
      const url = new URL(paper.url);
      if (url.protocol !== 'https:') throw new Error('Invalid link');
      const link = element('a', '', paper.title);
      link.href = url.href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const external = element('span', 'external', '↗');
      external.setAttribute('aria-hidden', 'true');
      link.append(external);
      heading.append(link);
    } catch (_) {
      heading.textContent = paper.title;
    }
    const authors = element('p', 'authors', (paper.authors || []).join(', ') || '作者信息未提供');
    const details = element('details');
    details.append(element('summary', '', '查看摘要'), element('p', 'abstract', paper.abstract || '来源未提供摘要。'));
    content.append(meta, heading, authors, details);
    article.append(ordinal, content);
    return article;
  }

  function renderPapers() {
    const term = search.value.trim().toLocaleLowerCase();
    const selectedSource = source.value;
    const matches = currentPapers.filter((paper) =>
      (selectedSource === 'all' || paper.source === selectedSource) &&
      (!term || `${paper.title} ${(paper.authors || []).join(' ')}`.toLocaleLowerCase().includes(term))
    );
    count.textContent = numberFormat.format(matches.length);
    if (!currentPapers.length) {
      setMessage('这一天暂无收录论文。试试选择其他日期。');
    } else if (!matches.length) {
      setMessage('没有符合筛选条件的论文。试试其他关键词或来源。');
    } else {
      results.replaceChildren(...matches.map(paperCard));
    }
  }

  async function selectDate(day, updateUrl = true) {
    if (!validDate(day)) return;
    currentDate = day;
    scopeYear = Number(day.slice(0, 4));
    scopeMonth = Number(day.slice(5, 7));
    renderHeatmap();
    $('selected-date').textContent = dateLabel(day);
    currentPapers = [];
    if (updateUrl) {
      const url = new URL(window.location.href);
      url.searchParams.set('date', day);
      window.history.pushState({}, '', url);
    }
    const thisRequest = ++requestNumber;
    if (!dateCounts.has(day)) {
      renderPapers();
      return;
    }
    count.textContent = '—';
    setMessage('正在加载当日论文…');
    try {
      const response = await fetch(`data/days/${day}.json`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const papers = await response.json();
      if (!Array.isArray(papers)) throw new Error('Invalid data');
      if (thisRequest !== requestNumber) return;
      currentPapers = papers;
      renderPapers();
    } catch (error) {
      if (thisRequest !== requestNumber) return;
      count.textContent = '—';
      setMessage('当日数据加载失败，请刷新页面后重试。', true);
      console.error('Unable to load daily data:', error);
    }
  }

  async function init() {
    try {
      const response = await fetch('data/index.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const index = await response.json();
      if (!Array.isArray(index.days)) throw new Error('Invalid date index');
      const today = new Date().toISOString().slice(0, 10);
      dates = index.days.map((day) => day.date).filter((day) => validDate(day) && day <= today).sort().reverse();
      dateCounts = new Map(index.days.map((day) => [day.date, day.count]));
      $('total-count').textContent = numberFormat.format(index.total);
      if (!dates.length) {
        $('selected-date').textContent = '暂无归档';
        count.textContent = '0';
        setMessage('尚无论文数据。运行采集脚本后即可浏览。');
        return;
      }
      $('date-span').textContent = `${dates[dates.length - 1].slice(0, 4)} — ${dates[0].slice(0, 4)}`;
      const requested = new URL(window.location.href).searchParams.get('date');
      await selectDate(requested && validDate(requested) && requested <= today ? requested : dates[0], false);
    } catch (error) {
      $('selected-date').textContent = '加载失败';
      setMessage('日期索引加载失败，请确认通过 HTTP 服务访问并刷新页面。', true);
      console.error('Unable to load date index:', error);
    }
  }

  for (const granularity of ['year', 'month', 'day']) {
    $('view-' + granularity).addEventListener('click', () => { view = granularity; renderHeatmap(); });
  }
  search.addEventListener('input', renderPapers);
  source.addEventListener('change', renderPapers);
  window.addEventListener('popstate', () => {
    const requested = new URL(window.location.href).searchParams.get('date');
    const today = new Date().toISOString().slice(0, 10);
    if (dates.length) selectDate(requested && validDate(requested) && requested <= today ? requested : dates[0], false);
  });
  init();
})();
