(function () {
  "use strict";

  var DEFAULT_CONFIG = {
    dataBaseUrl: "../data",
    historyDays: 14,
    pollIntervalMs: 60000,
  };

  var CHART = {
    top: 24,
    right: 28,
    bottom: 48,
    left: 68,
  };
  var DISPLAY_SCALE = 100;

  var config = readConfig();
  var state = {
    ticks: [],
    isLoading: false,
    hasLoaded: false,
    timerId: null,
  };

  var els = {
    level: document.getElementById("index-level"),
    updated: document.getElementById("last-updated"),
    chart: document.getElementById("history-chart"),
    chartWrap: document.getElementById("chart-wrap"),
    pointCount: document.getElementById("point-count"),
    historyWindow: document.getElementById("history-window"),
    refreshButton: document.getElementById("refresh-button"),
    connectionState: document.getElementById("connection-state"),
    lastChecked: document.getElementById("last-checked"),
  };

  init();

  function init() {
    els.refreshButton.addEventListener("click", function () {
      loadData({ manual: true });
    });

    document.addEventListener("visibilitychange", function () {
      if (!document.hidden) {
        loadData();
      }
    });

    window.addEventListener("resize", function () {
      renderChart(state.ticks);
    });

    loadData();
    state.timerId = window.setInterval(loadData, config.pollIntervalMs);
  }

  function readConfig() {
    var params = new URLSearchParams(window.location.search);
    var runtimeConfig = window.PMINDEX_CONFIG || {};
    var merged = Object.assign({}, DEFAULT_CONFIG, runtimeConfig);

    if (params.has("data")) {
      merged.dataBaseUrl = params.get("data");
    }
    if (params.has("days")) {
      merged.historyDays = parsePositiveInt(params.get("days"), merged.historyDays);
    }
    if (params.has("poll")) {
      merged.pollIntervalMs = parsePositiveInt(params.get("poll"), merged.pollIntervalMs);
    }

    merged.dataBaseUrl = String(merged.dataBaseUrl || "").replace(/\/+$/, "");
    merged.historyDays = Math.max(1, Math.min(90, parsePositiveInt(merged.historyDays, 14)));
    merged.pollIntervalMs = Math.max(15000, parsePositiveInt(merged.pollIntervalMs, 60000));
    return merged;
  }

  function parsePositiveInt(value, fallback) {
    var parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }

  async function loadData(options) {
    if (state.isLoading) {
      return;
    }

    state.isLoading = true;
    els.refreshButton.disabled = true;
    setConnectionState(state.hasLoaded ? "Updating" : "Loading", "");

    try {
      var tickDocs = await fetchRecentTickDocs();
      var ticks = normalizeTicks(tickDocs);

      state.ticks = ticks;
      state.hasLoaded = true;

      render();
      setConnectionState("Live", "is-live");
      els.lastChecked.textContent = "Checked " + formatClock(new Date());
    } catch (error) {
      renderError(error);
      setConnectionState("Error", "is-error");
    } finally {
      state.isLoading = false;
      els.refreshButton.disabled = false;
      if (options && options.manual) {
        els.refreshButton.blur();
      }
    }
  }

  async function fetchRecentTickDocs() {
    var keys = recentUtcDateKeys(config.historyDays);
    var requests = keys.map(function (dateKey) {
      return fetchJson(tickKeyForDate(dateKey), { required: false });
    });
    var docs = await Promise.all(requests);
    return docs.filter(Boolean);
  }

  async function fetchJson(path, options) {
    var response = await window.fetch(cacheBustedUrl(resolveDataUrl(path)), {
      cache: "no-store",
    });

    if (!response.ok) {
      if (!options.required && (response.status === 403 || response.status === 404)) {
        return null;
      }
      throw new Error(response.status + " " + response.statusText + " for " + path);
    }

    return response.json();
  }

  function resolveDataUrl(path) {
    if (/^https?:\/\//i.test(path)) {
      return path;
    }

    var cleanPath = String(path).replace(/^\/+/, "");
    if (!config.dataBaseUrl) {
      return cleanPath;
    }
    return config.dataBaseUrl + "/" + cleanPath;
  }

  function cacheBustedUrl(url) {
    var separator = url.indexOf("?") === -1 ? "?" : "&";
    return url + separator + "v=" + Date.now();
  }

  function recentUtcDateKeys(days) {
    var today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    var keys = [];
    for (var offset = days - 1; offset >= 0; offset -= 1) {
      var date = new Date(today);
      date.setUTCDate(today.getUTCDate() - offset);
      keys.push(date.toISOString().slice(0, 10));
    }
    return keys;
  }

  function tickKeyForDate(dateKey) {
    var parts = dateKey.split("-");
    return "ticks/" + parts[0] + "/" + parts[1] + "/" + parts[2] + ".json";
  }

  function normalizeTicks(docs) {
    var byTimestamp = new Map();

    docs.forEach(function (doc) {
      (doc.ticks || []).forEach(function (tick) {
        var timestamp = new Date(tick.timestamp);
        var value = Number(tick.index_value);
        if (!Number.isFinite(timestamp.getTime()) || !Number.isFinite(value)) {
          return;
        }
        byTimestamp.set(tick.timestamp, {
          timestamp: tick.timestamp,
          date: timestamp,
          indexValue: value,
          warnings: tick.warnings || [],
        });
      });
    });

    return Array.from(byTimestamp.values()).sort(function (a, b) {
      return a.date - b.date;
    });
  }

  function render() {
    var latest = state.ticks[state.ticks.length - 1] || null;

    els.level.textContent = latest ? formatBasisPoints(latest.indexValue) : "--";
    els.updated.textContent = latest ? formatDateTime(latest.date) : "--";

    renderChart(state.ticks);
    renderChartSummary(state.ticks);
  }

  function renderChart(ticks) {
    clearNode(els.chart);
    setChartViewBox();

    if (!ticks.length) {
      els.chartWrap.classList.remove("has-data");
      return;
    }

    els.chartWrap.classList.add("has-data");

    var plot = getPlotBounds();
    var dates = ticks.map(function (tick) {
      return tick.date.getTime();
    });
    var values = ticks.map(function (tick) {
      return toBasisPoints(tick.indexValue);
    });
    var domainX = paddedTimeDomain(Math.min.apply(null, dates), Math.max.apply(null, dates));
    var domainY = paddedValueDomain(Math.min.apply(null, values), Math.max.apply(null, values));

    renderGrid(plot, domainY);
    renderXAxis(plot, domainX);
    renderLine(plot, ticks, domainX, domainY);
  }

  function getPlotBounds() {
    var width = Math.max(320, Math.round(els.chart.clientWidth || 920));
    var height = Math.max(300, Math.round(els.chart.clientHeight || 370));
    return {
      left: CHART.left,
      top: CHART.top,
      right: width - CHART.right,
      bottom: height - CHART.bottom,
      width: width - CHART.left - CHART.right,
      height: height - CHART.top - CHART.bottom,
    };
  }

  function setChartViewBox() {
    var width = Math.max(320, Math.round(els.chart.clientWidth || 920));
    var height = Math.max(300, Math.round(els.chart.clientHeight || 370));
    els.chart.setAttribute("viewBox", "0 0 " + width + " " + height);
  }

  function paddedTimeDomain(min, max) {
    if (min === max) {
      return [min - 300000, max + 300000];
    }
    return [min, max];
  }

  function paddedValueDomain(min, max) {
    if (min === max) {
      var pad = Math.max(Math.abs(min) * 0.04, 0.1);
      return [Math.max(0, min - pad), max + pad];
    }

    var span = max - min;
    var padding = Math.max(span * 0.14, 0.1);
    return [Math.max(0, min - padding), max + padding];
  }

  function scaleX(value, plot, domain) {
    return plot.left + ((value - domain[0]) / (domain[1] - domain[0])) * plot.width;
  }

  function scaleY(value, plot, domain) {
    return plot.bottom - ((value - domain[0]) / (domain[1] - domain[0])) * plot.height;
  }

  function renderGrid(plot, domainY) {
    var group = svgEl("g", {});
    var steps = 4;

    for (var index = 0; index <= steps; index += 1) {
      var value = domainY[0] + ((domainY[1] - domainY[0]) * index) / steps;
      var y = scaleY(value, plot, domainY);
      group.appendChild(svgEl("line", {
        class: "chart-grid",
        x1: plot.left,
        x2: plot.right,
        y1: y,
        y2: y,
      }));
      var label = svgEl("text", {
        class: "chart-axis-label",
        x: plot.left - 12,
        y: y + 4,
        "text-anchor": "end",
      });
      label.textContent = formatDisplayNumber(value);
      group.appendChild(label);
    }

    els.chart.appendChild(group);
  }

  function renderXAxis(plot, domainX) {
    var labels = [domainX[0], domainX[0] + (domainX[1] - domainX[0]) / 2, domainX[1]];
    labels.forEach(function (value, index) {
      var x = scaleX(value, plot, domainX);
      var anchor = index === 0 ? "start" : index === 2 ? "end" : "middle";
      var label = svgEl("text", {
        class: "chart-axis-label",
        x: x,
        y: plot.bottom + 30,
        "text-anchor": anchor,
      });
      label.textContent = formatAxisDate(new Date(value), domainX);
      els.chart.appendChild(label);
    });
  }

  function renderLine(plot, ticks, domainX, domainY) {
    var points = ticks.map(function (tick) {
      return {
        x: scaleX(tick.date.getTime(), plot, domainX),
        y: scaleY(toBasisPoints(tick.indexValue), plot, domainY),
      };
    });

    var pathData = points.map(function (point, index) {
      return (index === 0 ? "M " : "L ") + round(point.x) + " " + round(point.y);
    }).join(" ");

    els.chart.appendChild(svgEl("path", {
      class: "chart-line",
      d: pathData,
    }));

    var latest = points[points.length - 1];
    els.chart.appendChild(svgEl("circle", {
      class: "chart-point",
      cx: latest.x,
      cy: latest.y,
      r: 5,
    }));
  }

  function renderChartSummary(ticks) {
    if (!ticks.length) {
      els.pointCount.textContent = "0 ticks";
      els.historyWindow.textContent = config.historyDays + " day window";
      return;
    }

    var first = ticks[0].date;
    var last = ticks[ticks.length - 1].date;
    els.pointCount.textContent = formatInteger(ticks.length) + (ticks.length === 1 ? " tick" : " ticks");
    els.historyWindow.textContent = formatHistoryWindow(first, last);
  }

  function renderError(error) {
    if (!state.hasLoaded) {
      els.level.textContent = "--";
      els.updated.textContent = "--";
      renderChart([]);
      els.pointCount.textContent = "0 ticks";
      els.historyWindow.textContent = config.historyDays + " day window";
    }

    els.lastChecked.textContent = error.message;
  }

  function setConnectionState(label, className) {
    els.connectionState.className = "connection-state " + className;
    els.connectionState.lastChild.textContent = label;
  }

  function clearNode(node) {
    while (node.firstChild) {
      node.removeChild(node.firstChild);
    }
  }

  function svgEl(name, attrs) {
    var element = document.createElementNS("http://www.w3.org/2000/svg", name);
    Object.keys(attrs).forEach(function (key) {
      element.setAttribute(key, attrs[key]);
    });
    return element;
  }

  function round(value) {
    return Math.round(value * 100) / 100;
  }

  function toBasisPoints(value) {
    return value * DISPLAY_SCALE;
  }

  function formatBasisPoints(value) {
    return formatDisplayNumber(toBasisPoints(value));
  }

  function formatDisplayNumber(value) {
    if (!Number.isFinite(value)) {
      return "--";
    }
    return new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }

  function formatInteger(value) {
    if (!Number.isFinite(Number(value))) {
      return "--";
    }
    return Number(value).toLocaleString(undefined, {
      maximumFractionDigits: 0,
    });
  }

  function formatDateTime(date) {
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  }

  function formatShortDate(date) {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }

  function formatAxisDate(date, domainX) {
    var start = new Date(domainX[0]);
    var end = new Date(domainX[1]);
    if (isSameDisplayedDay(start, end)) {
      return formatShortTime(date);
    }
    if (end - start <= 2 * 24 * 60 * 60 * 1000) {
      return date.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
      });
    }
    return formatShortDate(date);
  }

  function formatHistoryWindow(first, last) {
    if (isSameDisplayedDay(first, last)) {
      return formatShortDate(first) + ", " + formatShortTime(first) + " to " + formatShortTime(last);
    }
    return formatShortDate(first) + " to " + formatShortDate(last);
  }

  function isSameDisplayedDay(first, last) {
    return first.toLocaleDateString() === last.toLocaleDateString();
  }

  function formatShortTime(date) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatClock(date) {
    return date.toLocaleTimeString(undefined, {
      hour: "numeric",
      minute: "2-digit",
      second: "2-digit",
    });
  }
})();
