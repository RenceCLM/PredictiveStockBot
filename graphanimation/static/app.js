const statusTextEl = document.getElementById('statusText');
const legendListEl = document.getElementById('legendList');
const infoTitleEl = document.getElementById('infoTitle');
const loadingOverlayEl = document.getElementById('loadingOverlay');
const loadingMessageEl = document.getElementById('loadingMessage');
const loadingBarEl = document.getElementById('loadingBar');
const loadingPercentEl = document.getElementById('loadingPercent');

const predSymbolSelectEl = document.getElementById('predSymbolSelect');
const modelSelectEl = document.getElementById('modelSelect');
const chartTypeSelectEl = document.getElementById('chartTypeSelect');
const speedRangeEl = document.getElementById('speedRange');
const forecastRangeEl = document.getElementById('forecastRange');
const forecastDaysValueEl = document.getElementById('forecastDaysValue');
const startingCashInputEl = document.getElementById('startingCashInput');
const loadPredBtn = document.getElementById('loadPredBtn');
const randomRealBtn = document.getElementById('randomRealBtn');
const randomPredBtn = document.getElementById('randomPredBtn');
const focusBtn = document.getElementById('focusBtn');
const playBtn = document.getElementById('playBtn');
const pauseBtn = document.getElementById('pauseBtn');
const resetBtn = document.getElementById('resetBtn');
const stepBackBtn = document.getElementById('stepBackBtn');
const stepFwdBtn = document.getElementById('stepFwdBtn');

const frameSliderEl = document.getElementById('frameSlider');
const frameLabelEl = document.getElementById('frameLabel');
const bottomPanelEl = document.getElementById('bottomPanel');
const viewerShellEl = document.querySelector('.viewer-shell');
const chartEl = document.getElementById('priceChart');

const metrics = JSON.parse(document.getElementById('metricsJson').textContent || '{}');

const appState = {
  frameIndex: 0,
  animationId: null,
  loadingCount: 0,
  playback: null,
  activeModel: metrics?.defaults?.default_model || modelSelectEl?.value || 'trading',
  focusCurrent: true,
  ghostDays: Number(forecastRangeEl?.value || 5),
  startingCash: Number(startingCashInputEl?.value || metrics?.defaults?.starting_cash_reference || 100000),
};

function setStatus(text) {
  statusTextEl.textContent = text;
}

function setLoading(isLoading, message) {
  if (isLoading) {
    appState.loadingCount += 1;
    loadingMessageEl.textContent = message || 'Loading...';
    if (loadingBarEl) {
      loadingBarEl.style.width = '0%';
    }
    if (loadingPercentEl) {
      loadingPercentEl.textContent = '0%';
    }
    loadingOverlayEl.classList.remove('hidden');
    return;
  }

  appState.loadingCount = Math.max(0, appState.loadingCount - 1);
  if (appState.loadingCount === 0) {
    loadingOverlayEl.classList.add('hidden');
  }
}

function updateLoadingMessage(message) {
  loadingMessageEl.textContent = message;
}

function setLoadingProgress(percent) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  if (loadingBarEl) {
    loadingBarEl.style.width = `${clamped}%`;
  }
  if (loadingPercentEl) {
    loadingPercentEl.textContent = `${clamped}%`;
  }
}

function setLoadingStage(stageNumber, stageName, stageDetail) {
  updateLoadingMessage(`Stage ${stageNumber}/4 - ${stageName}: ${stageDetail}`);
}

function getSelectedForecastDays() {
  const raw = Number(forecastRangeEl?.value || appState.ghostDays || 5);
  return Math.max(1, Math.min(20, Number.isFinite(raw) ? Math.round(raw) : 5));
}

function getSelectedStartingCash() {
  const raw = Number(startingCashInputEl?.value || appState.startingCash || 100000);
  return Math.max(1, Number.isFinite(raw) ? raw : 100000);
}

function updateForecastLabel() {
  if (forecastDaysValueEl) {
    forecastDaysValueEl.textContent = String(appState.ghostDays);
  }
}

function updateTooltipText() {
  const helpEl = document.querySelector('.instant-help');
  if (!helpEl) return;

  if (appState.activeModel === 'forecast') {
    helpEl.setAttribute(
      'data-tip',
      'Forecast model input: up to 20 trading-day close lags, 10 volume lags, multi-window returns (1/3/5/10), moving averages, and distance-to-average features plus the symbol. Output: one-step-ahead close prediction for each frame. The played line shows day-by-day closes, while the ghost line extends a configurable number of days ahead using only data available at that frame.'
    );
  } else {
    helpEl.setAttribute(
      'data-tip',
      'Trading model input: the same market history features, plus the model predicts BUY / SELL / HOLD. BUY invests all available cash, SELL liquidates holdings, and HOLD keeps the position unchanged. Output: simulated portfolio growth from the selected starting cash amount.'
    );
  }
}

function updateModelControls() {
  const showForecastControls = appState.activeModel === 'forecast';

  document.querySelectorAll('[data-models]').forEach((element) => {
    const models = (element.getAttribute('data-models') || '').split(',').map((item) => item.trim());
    const visible = models.includes(appState.activeModel);
    element.classList.toggle('hidden', !visible);
  });

  if (loadPredBtn) {
    loadPredBtn.textContent = showForecastControls ? 'Load Forecast' : 'Load Trading';
  }
  if (randomRealBtn) {
    randomRealBtn.textContent = showForecastControls ? 'Choose Random Stock' : 'Random Stock Backtest';
  }
  if (randomPredBtn) {
    randomPredBtn.classList.toggle('hidden', !showForecastControls);
  }

  updateTooltipText();
  updateForecastLabel();
}

function nextPaint() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

function formatBytesToMB(bytes) {
  return (bytes / (1024 * 1024)).toFixed(2);
}

function stopAnimation() {
  if (appState.animationId) {
    clearInterval(appState.animationId);
    appState.animationId = null;
  }
}

function updateFocusButton() {
  if (!focusBtn) return;
  focusBtn.textContent = appState.focusCurrent ? 'Focus: On' : 'Focus: Off';
}

function setPlaybackPanelVisible(visible) {
  bottomPanelEl.classList.toggle('hidden', !visible);
  viewerShellEl.classList.toggle('playback-open', visible);
  requestAnimationFrame(() => Plotly.Plots.resize(chartEl));
}

function renderLegend(items) {
  legendListEl.innerHTML = '';

  if (!items.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No data';
    legendListEl.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const row = document.createElement('div');
    row.className = 'legend-item';

    const swatch = document.createElement('span');
    swatch.className = 'legend-swatch';
    swatch.style.backgroundColor = item.color;

    const label = document.createElement('span');
    label.textContent = item.label;

    row.appendChild(swatch);
    row.appendChild(label);
    legendListEl.appendChild(row);
  });
}

function baseLayout(title) {
  return {
    title: { text: title, font: { color: '#e2e8f0' } },
    paper_bgcolor: '#020617',
    plot_bgcolor: '#020617',
    margin: { l: 70, r: 30, t: 45, b: 60 },
    xaxis: {
      type: 'date',
      title: { text: 'Date', font: { color: '#cbd5e1' } },
      gridcolor: 'rgba(148, 163, 184, 0.2)',
      minor: {
        dtick: 24 * 60 * 60 * 1000,
        showgrid: true,
        gridcolor: 'rgba(148, 163, 184, 0.12)',
      },
      tickfont: { color: '#cbd5e1' },
      rangeslider: { visible: false },
      rangebreaks: [{ bounds: ['sat', 'mon'] }],
    },
    yaxis: {
      title: { text: 'Price', font: { color: '#cbd5e1' } },
      gridcolor: 'rgba(148, 163, 184, 0.2)',
      tickfont: { color: '#cbd5e1' },
    },
    showlegend: false,
    hovermode: 'x unified',
  };
}

function formatMetrics(symbol) {
  const rows = [];

  rows.push({ label: `Symbol: ${symbol}`, color: '#38bdf8' });
  if (appState.activeModel === 'forecast') {
    const overall = metrics?.forecast?.overall;
    const bySymbol = metrics?.forecast?.by_symbol?.[symbol];
    if (overall?.actual_first_test_date) {
      rows.push({ label: `Test start: ${overall.actual_first_test_date}`, color: '#22d3ee' });
    }
    if (overall?.rmse != null) {
      rows.push({ label: `Overall RMSE: ${Number(overall.rmse).toFixed(4)}`, color: '#a78bfa' });
    }
    if (bySymbol?.rmse != null) {
      rows.push({ label: `${symbol} RMSE: ${Number(bySymbol.rmse).toFixed(4)}`, color: '#f59e0b' });
    }
    if (bySymbol?.mae != null) {
      rows.push({ label: `${symbol} MAE: ${Number(bySymbol.mae).toFixed(4)}`, color: '#f97316' });
    }
    rows.push({ label: 'Actual price = blue/green', color: '#60a5fa' });
    rows.push({ label: 'Played prediction = orange', color: '#f59e0b' });
    rows.push({ label: 'Prediction ghost = recursive forecast from current frame', color: '#fb923c' });

    const randomWindow = appState.playback?.random_window;
    if (randomWindow) {
      const modeLabel = randomWindow.synthetic ? 'Generated random stock data' : 'Chosen random stock';
      rows.push({
        label: `${modeLabel}: ${randomWindow.start_date} to ${randomWindow.end_date} (${randomWindow.n_test_points} points)`,
        color: '#22d3ee',
      });
    }
    return rows;
  }

  const overall = metrics?.trading?.overall;
  const bySymbol = metrics?.trading?.by_symbol?.[symbol];
  const currentIndex = Math.max(0, Math.min(appState.frameIndex, (appState.playback?.test_dates || []).length - 1));
  const currentPortfolio = appState.playback?.test_portfolio_value?.[currentIndex];
  const currentCash = appState.playback?.test_cash?.[currentIndex];
  const currentShares = appState.playback?.test_shares?.[currentIndex];

  if (appState.playback?.starting_cash != null) {
    rows.push({ label: `Starting cash: $${Number(appState.playback.starting_cash).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, color: '#22d3ee' });
  }
  if (currentPortfolio != null) {
    rows.push({ label: `Current portfolio: $${Number(currentPortfolio).toLocaleString(undefined, { maximumFractionDigits: 2 })}`, color: '#f59e0b' });
  }
  if (currentCash != null && currentShares != null) {
    rows.push({ label: `Cash: $${Number(currentCash).toLocaleString(undefined, { maximumFractionDigits: 2 })} | Shares: ${Number(currentShares).toFixed(4)}`, color: '#cbd5e1' });
  }
  if (bySymbol?.final_return_pct != null) {
    rows.push({ label: `${symbol} Strategy Return: ${Number(bySymbol.final_return_pct).toFixed(2)}%`, color: '#22c55e' });
  }
  if (bySymbol?.buy_hold_return_pct != null) {
    rows.push({ label: `${symbol} Buy & Hold: ${Number(bySymbol.buy_hold_return_pct).toFixed(2)}%`, color: '#a78bfa' });
  }
  if (overall?.accuracy != null) {
    rows.push({ label: `Action accuracy: ${Number(overall.accuracy * 100).toFixed(1)}%`, color: '#38bdf8' });
  }
  if (overall?.mean_return_advantage_pct != null) {
    rows.push({ label: `Mean return advantage: ${Number(overall.mean_return_advantage_pct).toFixed(2)}%`, color: '#f59e0b' });
  }
  rows.push({ label: 'BUY = invest all cash', color: '#22c55e' });
  rows.push({ label: 'SELL = liquidate holdings', color: '#f97316' });
  rows.push({ label: 'HOLD = keep position', color: '#cbd5e1' });

  const randomWindow = appState.playback?.random_window;
  if (randomWindow) {
    rows.push({
      label: `Random stock: ${randomWindow.start_date} to ${randomWindow.end_date} (${randomWindow.n_test_points} points)`,
      color: '#22d3ee',
    });
  }

  return rows;
}

function buildTraces(frame) {
  const p = appState.playback;
  if (!p) return [];

  const frameMax = Math.max(p.test_dates.length - 1, 0);
  const cappedFrame = Math.max(0, Math.min(frame, frameMax));
  const visibleEnd = p.test_start_index + cappedFrame + 1;

  const actualX = p.history_dates.slice(0, visibleEnd);
  const actualClose = p.history_close.slice(0, visibleEnd);

  const predSeenX = p.test_dates.slice(0, cappedFrame + 1);
  const predSeenY = p.test_pred.slice(0, cappedFrame + 1);

  const ghostX = p.forecast_dates_paths?.[cappedFrame] || p.test_dates.slice(cappedFrame, cappedFrame + 5);
  const ghostY = p.forecast_close_paths?.[cappedFrame] || p.test_pred.slice(cappedFrame, cappedFrame + 5);
  const ghostLimit = Math.max(1, appState.ghostDays || 1);
  const ghostXVisible = ghostX.slice(0, ghostLimit);
  const ghostYVisible = ghostY.slice(0, ghostLimit);

  const actualTestX = p.test_dates.slice(0, cappedFrame + 1);
  const actualTestY = p.test_actual.slice(0, cappedFrame + 1);

  if (chartTypeSelectEl.value === 'candle') {
    const actualOpen = p.history_open.slice(0, visibleEnd);
    const actualHigh = p.history_high.slice(0, visibleEnd);
    const actualLow = p.history_low.slice(0, visibleEnd);

    return [
      {
        type: 'candlestick',
        x: actualX,
        open: actualOpen,
        high: actualHigh,
        low: actualLow,
        close: actualClose,
        increasing: { line: { color: '#34d399' } },
        decreasing: { line: { color: '#f43f5e' } },
        name: 'Actual OHLC',
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: predSeenX,
        y: predSeenY,
        line: { color: '#f59e0b', width: 2.4 },
        name: 'Prediction (Played)',
      },
      {
        type: 'scatter',
        mode: 'lines',
        x: ghostXVisible,
        y: ghostYVisible,
        line: { color: '#f97316', width: 2, dash: 'dot' },
        opacity: 0.35,
        name: 'Prediction Ghost',
      },
      {
        type: 'scatter',
        mode: 'markers',
        x: actualTestX,
        y: actualTestY,
        marker: { color: '#60a5fa', size: 5, opacity: 0.8 },
        name: 'Actual (Test)',
      },
    ];
  }

  return [
    {
      type: 'scatter',
      mode: 'lines',
      x: actualX,
      y: actualClose,
      name: 'Actual',
      line: { color: '#60a5fa', width: 2.2 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: predSeenX,
      y: predSeenY,
      name: 'Prediction (Played)',
      line: { color: '#f59e0b', width: 2.4 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: ghostXVisible,
      y: ghostYVisible,
      name: 'Prediction Ghost',
      line: { color: '#f97316', width: 2.2, dash: 'dot' },
        opacity: 0.45,
    },
    {
      type: 'scatter',
      mode: 'markers',
      x: actualTestX,
      y: actualTestY,
      name: 'Actual (Test)',
      marker: { color: '#22d3ee', size: 5, opacity: 0.85 },
    },
  ];
}

function tradingLayout(title) {
  const layout = baseLayout(title);
  layout.yaxis = {
    ...layout.yaxis,
    title: { text: 'Price', font: { color: '#cbd5e1' } },
  };
  layout.yaxis2 = {
    title: { text: 'Portfolio Value', font: { color: '#f8fafc' } },
    titlefont: { color: '#f8fafc' },
    tickfont: { color: '#f8fafc' },
    overlaying: 'y',
    side: 'right',
    gridcolor: 'rgba(148, 163, 184, 0.08)',
    zeroline: false,
  };
  return layout;
}

function buildTradingTraces(frame) {
  const p = appState.playback;
  if (!p) return [];

  const frameMax = Math.max(p.test_dates.length - 1, 0);
  const cappedFrame = Math.max(0, Math.min(frame, frameMax));
  const visibleEnd = Math.min(p.history_dates.length, p.test_start_index + cappedFrame + 1);

  const actualX = p.history_dates.slice(0, visibleEnd);
  const actualClose = p.history_close.slice(0, visibleEnd);
  const actionDates = p.test_dates.slice(0, cappedFrame + 1);
  const actionPrices = p.test_target_close.slice(0, cappedFrame + 1);
  const portfolioValues = p.test_portfolio_value.slice(0, cappedFrame + 1);
  const buyHoldValues = p.buy_hold_value.slice(0, cappedFrame + 1);
  const actions = p.test_actions.slice(0, cappedFrame + 1);

  const buyX = [];
  const buyY = [];
  const sellX = [];
  const sellY = [];

  actions.forEach((action, index) => {
    if (action === 'BUY') {
      buyX.push(actionDates[index]);
      buyY.push(actionPrices[index]);
    } else if (action === 'SELL') {
      sellX.push(actionDates[index]);
      sellY.push(actionPrices[index]);
    }
  });

  const priceTrace = chartTypeSelectEl.value === 'candle'
    ? {
        type: 'candlestick',
        x: actualX,
        open: p.history_open.slice(0, visibleEnd),
        high: p.history_high.slice(0, visibleEnd),
        low: p.history_low.slice(0, visibleEnd),
        close: actualClose,
        increasing: { line: { color: '#34d399' } },
        decreasing: { line: { color: '#f43f5e' } },
        name: 'Actual OHLC',
      }
    : {
        type: 'scatter',
        mode: 'lines',
        x: actualX,
        y: actualClose,
        name: 'Actual',
        line: { color: '#60a5fa', width: 2.2 },
      };

  return [
    priceTrace,
    {
      type: 'scatter',
      mode: 'lines',
      x: actionDates,
      y: portfolioValues,
      name: 'Strategy Portfolio',
      yaxis: 'y2',
      line: { color: '#f59e0b', width: 2.4 },
    },
    {
      type: 'scatter',
      mode: 'lines',
      x: actionDates,
      y: buyHoldValues,
      name: 'Buy & Hold',
      yaxis: 'y2',
      line: { color: '#a78bfa', width: 2, dash: 'dot' },
      opacity: 0.75,
    },
    {
      type: 'scatter',
      mode: 'markers',
      x: buyX,
      y: buyY,
      name: 'BUY',
      marker: { color: '#22c55e', size: 8, symbol: 'triangle-up' },
    },
    {
      type: 'scatter',
      mode: 'markers',
      x: sellX,
      y: sellY,
      name: 'SELL',
      marker: { color: '#f97316', size: 8, symbol: 'triangle-down' },
    },
  ];
}

function drawFrame(frame) {
  const p = appState.playback;
  if (!p) return;

  const frameMax = Math.max(p.test_dates.length - 1, 0);
  const cappedFrame = Math.max(0, Math.min(frame, frameMax));
  const isTrading = appState.activeModel === 'trading';
  const traces = isTrading ? buildTradingTraces(cappedFrame) : buildTraces(cappedFrame);

  const layout = isTrading ? tradingLayout(`${p.symbol} Trading Path`) : baseLayout(`${p.symbol} Prediction Path`);
  if (appState.focusCurrent && p.history_dates.length) {
    const centerIndex = Math.min(p.history_dates.length - 1, p.test_start_index + cappedFrame);
    const startIndex = Math.max(0, centerIndex - 20);
    const endIndex = Math.min(p.history_dates.length - 1, centerIndex + 20);
    layout.xaxis = {
      ...layout.xaxis,
      range: [p.history_dates[startIndex], p.history_dates[endIndex]],
      dtick: undefined,
      nticks: 6,
      tickformat: '%b %d',
      tickangle: -20,
    };
  } else {
    layout.xaxis = {
      ...layout.xaxis,
      dtick: undefined,
      nticks: undefined,
      tickformat: undefined,
      tickangle: 0,
    };
  }

  Plotly.react(chartEl, traces, layout, { responsive: true });

  const currentDate = p.test_dates[cappedFrame] || '';
  frameSliderEl.value = String(cappedFrame);
  frameLabelEl.textContent = `Frame ${cappedFrame + 1} / ${Math.max(p.test_dates.length, 1)}${currentDate ? ` (${currentDate})` : ''}`;

  if (isTrading) {
    const action = p.test_actions[cappedFrame];
    const portfolio = p.test_portfolio_value[cappedFrame];
    const cash = p.test_cash[cappedFrame];
    const shares = p.test_shares[cappedFrame];
    if (action != null && portfolio != null) {
      setStatus(
        `Date: ${currentDate} | Action: ${action} | Portfolio: ${Number(portfolio).toLocaleString(undefined, { maximumFractionDigits: 2 })} | Cash: ${Number(cash).toLocaleString(undefined, { maximumFractionDigits: 2 })} | Shares: ${Number(shares).toFixed(4)}`
      );
    } else {
      setStatus(`Frame ${cappedFrame + 1}/${Math.max(p.test_dates.length, 1)}`);
    }
  } else {
    const latestPred = p.test_pred[cappedFrame];
    const latestActual = p.test_actual[cappedFrame];
    if (latestPred != null && latestActual != null) {
      setStatus(`Date: ${currentDate} | Predicted: ${Number(latestPred).toFixed(2)} | Actual: ${Number(latestActual).toFixed(2)}`);
    } else {
      setStatus(`Frame ${cappedFrame + 1}/${Math.max(p.test_dates.length, 1)}`);
    }
  }
}

async function loadSelectedPlayback() {
  if (appState.activeModel === 'forecast') {
    return loadForecastPlayback();
  }
  return loadTradingPlayback();
}

async function loadForecastPlayback() {
  stopAnimation();
  infoTitleEl.textContent = 'Legend';

  const symbol = predSymbolSelectEl.value;
  const horizon = String(getSelectedForecastDays());
  const params = new URLSearchParams({ symbol, horizon });

  setLoading(true, `Fetching playback for ${symbol}...`);
  setStatus(`Fetching real price history and model output for ${symbol}...`);

  try {
    setLoadingStage(1, 'Request', 'requesting model playback payload from the server');
    setLoadingProgress(18);
    await nextPaint();
    const response = await fetch(`/api/playback?model=forecast&${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const responseClone = response.clone();
    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error);
    }

    const payloadText = await responseClone.text();
    const payloadBytes = new TextEncoder().encode(payloadText).length;
    const payloadMB = formatBytesToMB(payloadBytes);
    setLoadingStage(1, 'Request', `payload received (${payloadMB} MB)`);
    setLoadingProgress(40);
    await nextPaint();

    const firstFeedDate = payload.forecast_feed_dates?.[0];
    const lastFeedDate = payload.forecast_feed_dates?.[payload.forecast_feed_dates.length - 1];
    setLoadingStage(
      2,
      'Forecast',
      `feeding model day-by-day from ${firstFeedDate || 'n/a'} to ${lastFeedDate || 'n/a'} (horizon ${payload.forecast_close_paths?.[0]?.length || 0} days)`
    );
    setLoadingProgress(65);
    await nextPaint();
    appState.playback = payload;
    appState.frameIndex = 0;

    frameSliderEl.min = '0';
    frameSliderEl.max = String(Math.max((payload.test_dates || []).length - 1, 0));
    frameSliderEl.value = '0';

    setLoadingStage(3, 'Render', 'drawing the price history and prediction paths');
    setLoadingProgress(85);
    await nextPaint();
    setPlaybackPanelVisible(true);
    drawFrame(0);
    renderLegend(formatMetrics(payload.symbol));
    setLoadingStage(4, 'Ready', 'finalizing the interactive playback viewer');
    setLoadingProgress(100);
    await nextPaint();
    setStatus(`Loaded ${symbol}. The ghost line is forecasting forward from each frame using only data available up to that point.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load prediction: ${error.message}`);
    renderLegend([]);
    setPlaybackPanelVisible(false);
  } finally {
    setLoading(false);
  }
}

async function loadTradingPlayback() {
  stopAnimation();
  infoTitleEl.textContent = 'Legend';

  const symbol = predSymbolSelectEl.value;
  const startingCash = getSelectedStartingCash();
  const params = new URLSearchParams({ symbol, starting_cash: String(startingCash) });

  setLoading(true, `Fetching trading policy for ${symbol}...`);
  setStatus(`Fetching trading policy and simulating portfolio growth for ${symbol}...`);

  try {
    setLoadingStage(1, 'Request', 'requesting trading playback payload from the server');
    setLoadingProgress(18);
    await nextPaint();
    const response = await fetch(`/api/playback?model=trading&${params.toString()}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error);
    }

    appState.playback = payload;
    appState.frameIndex = 0;
    predSymbolSelectEl.value = payload.symbol;
    appState.startingCash = payload.starting_cash || startingCash;

    frameSliderEl.min = '0';
    frameSliderEl.max = String(Math.max((payload.test_dates || []).length - 1, 0));
    frameSliderEl.value = '0';

    setLoadingStage(2, 'Simulate', `running BUY / SELL / HOLD policy from $${Number(appState.startingCash).toLocaleString()}`);
    setLoadingProgress(65);
    await nextPaint();
    setPlaybackPanelVisible(true);
    drawFrame(0);
    renderLegend(formatMetrics(payload.symbol));
    setLoadingStage(3, 'Render', 'drawing the trading path and portfolio value');
    setLoadingProgress(85);
    await nextPaint();
    setLoadingStage(4, 'Ready', 'finalizing the trading view');
    setLoadingProgress(100);
    await nextPaint();
    setStatus(`Loaded ${symbol} trading policy. Portfolio simulation starts from $${Number(appState.startingCash).toLocaleString()}.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load trading model: ${error.message}`);
    renderLegend([]);
    setPlaybackPanelVisible(false);
  } finally {
    setLoading(false);
  }
}

async function loadRandomPlayback() {
  stopAnimation();
  infoTitleEl.textContent = 'Legend';

  setLoading(true, 'Choosing a real stock and generating synthetic price data from it...');
  setStatus('Choosing a real stock, then generating synthetic stock data from its shape and volatility...');

  try {
    setLoadingStage(1, 'Select', 'choosing a real stock to seed synthetic price behavior');
    setLoadingProgress(18);
    await nextPaint();
    const horizon = getSelectedForecastDays();
    const response = await fetch(`/api/random_playback?horizon=${encodeURIComponent(String(horizon))}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error);
    }

    const firstFeedDate = payload.forecast_feed_dates?.[0];
    const lastFeedDate = payload.forecast_feed_dates?.[payload.forecast_feed_dates.length - 1];
    appState.playback = payload;
    appState.frameIndex = 0;
    predSymbolSelectEl.value = payload.symbol;

    frameSliderEl.min = '0';
    frameSliderEl.max = String(Math.max((payload.test_dates || []).length - 1, 0));
    frameSliderEl.value = '0';

    setLoadingStage(
      2,
      'Generate',
      `creating synthetic OHLC data and feeding model from ${firstFeedDate || 'n/a'} to ${lastFeedDate || 'n/a'}`
    );
    setLoadingProgress(65);
    await nextPaint();
    setPlaybackPanelVisible(true);
    drawFrame(0);
    renderLegend(formatMetrics(payload.symbol));
    setLoadingStage(3, 'Render', 'drawing the generated stock chart');
    setLoadingProgress(85);
    await nextPaint();
    setLoadingStage(4, 'Ready', 'finalizing the generated playback view');
    setLoadingProgress(100);
    await nextPaint();
    setStatus(`Generated synthetic data from ${payload.symbol}. The ghost forecast updates recursively from the current frame.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to generate random stock data: ${error.message}`);
    renderLegend([]);
    setPlaybackPanelVisible(false);
  } finally {
    setLoading(false);
  }
}

async function loadRandomRealPlayback() {
  stopAnimation();
  infoTitleEl.textContent = 'Legend';

  setLoading(true, 'Choosing a random real stock from the dataset...');
  setStatus('Choosing a random real stock and loading its real playback window...');

  try {
    setLoadingStage(1, 'Select', 'choosing a real stock with trained predictions');
    setLoadingProgress(18);
    await nextPaint();
    if (appState.activeModel === 'forecast') {
      const horizon = getSelectedForecastDays();
      const response = await fetch(`/api/random_real_playback?model=forecast&horizon=${encodeURIComponent(String(horizon))}`);
      if (!response.ok) {
        throw new Error(`Request failed with status ${response.status}`);
      }

      const payload = await response.json();
      if (payload.error) {
        throw new Error(payload.error);
      }

      const firstFeedDate = payload.forecast_feed_dates?.[0];
      const lastFeedDate = payload.forecast_feed_dates?.[payload.forecast_feed_dates.length - 1];
      appState.playback = payload;
      appState.frameIndex = 0;
      predSymbolSelectEl.value = payload.symbol;

      frameSliderEl.min = '0';
      frameSliderEl.max = String(Math.max((payload.test_dates || []).length - 1, 0));
      frameSliderEl.value = '0';

      setLoadingStage(
        2,
        'Forecast',
        `assembling playback and feeding model from ${firstFeedDate || 'n/a'} to ${lastFeedDate || 'n/a'}`
      );
      setLoadingProgress(65);
      await nextPaint();
      setPlaybackPanelVisible(true);
      drawFrame(0);
      renderLegend(formatMetrics(payload.symbol));
      setLoadingStage(3, 'Render', 'drawing the real stock playback chart');
      setLoadingProgress(85);
      await nextPaint();
      setLoadingStage(4, 'Ready', 'finalizing the interactive view');
      setLoadingProgress(100);
      await nextPaint();
      setStatus(`Loaded random real stock ${payload.symbol}. The ghost line is forecast from the current frame, not from future actuals.`);
      return;
    }

    const startingCash = getSelectedStartingCash();
    const response = await fetch(`/api/random_real_playback?model=trading&starting_cash=${encodeURIComponent(String(startingCash))}`);
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    if (payload.error) {
      throw new Error(payload.error);
    }

    const firstFeedDate = payload.test_dates?.[0];
    const lastFeedDate = payload.test_dates?.[payload.test_dates.length - 1];
    appState.playback = payload;
    appState.frameIndex = 0;
    predSymbolSelectEl.value = payload.symbol;
    appState.startingCash = payload.starting_cash || startingCash;

    frameSliderEl.min = '0';
    frameSliderEl.max = String(Math.max((payload.test_dates || []).length - 1, 0));
    frameSliderEl.value = '0';

    setLoadingStage(
      2,
      'Simulate',
      `running trading policy from ${firstFeedDate || 'n/a'} to ${lastFeedDate || 'n/a'} starting at $${Number(appState.startingCash).toLocaleString()}`
    );
    setLoadingProgress(65);
    await nextPaint();
    setPlaybackPanelVisible(true);
    drawFrame(0);
    renderLegend(formatMetrics(payload.symbol));
    setLoadingStage(3, 'Render', 'drawing the real stock trading chart');
    setLoadingProgress(85);
    await nextPaint();
    setLoadingStage(4, 'Ready', 'finalizing the interactive view');
    setLoadingProgress(100);
    await nextPaint();
    setStatus(`Loaded random real stock ${payload.symbol} trading backtest.`);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to choose a random stock: ${error.message}`);
    renderLegend([]);
    setPlaybackPanelVisible(false);
  } finally {
    setLoading(false);
  }
}

function play() {
  if (!appState.playback) return;

  stopAnimation();
  appState.animationId = setInterval(() => {
    const maxFrame = Math.max((appState.playback.test_dates || []).length - 1, 0);
    appState.frameIndex = Math.min(maxFrame, appState.frameIndex + 1);
    drawFrame(appState.frameIndex);

    if (appState.frameIndex >= maxFrame) {
      stopAnimation();
    }
  }, Number(speedRangeEl.value));
}

function pause() {
  stopAnimation();
}

function reset() {
  if (!appState.playback) return;
  stopAnimation();
  appState.frameIndex = 0;
  drawFrame(appState.frameIndex);
}

function stepFrame(delta) {
  if (!appState.playback) return;

  stopAnimation();
  const maxFrame = Math.max((appState.playback.test_dates || []).length - 1, 0);
  appState.frameIndex = Math.max(0, Math.min(maxFrame, appState.frameIndex + delta));
  drawFrame(appState.frameIndex);
}

function setupPanels() {
  const revealPanel = (panel) => {
    if (!panel || panel.classList.contains('pinned')) return;
    panel.classList.remove('collapsed');
  };

  const collapsePanel = (panel) => {
    if (!panel || panel.classList.contains('pinned')) return;
    panel.classList.add('collapsed');
  };

  document.querySelectorAll('.pin-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = document.getElementById(button.getAttribute('data-target'));
      if (!panel) return;

      if (panel.classList.contains('pinned')) {
        panel.classList.remove('pinned');
        panel.classList.add('collapsed');
      } else {
        panel.classList.add('pinned');
        panel.classList.remove('collapsed');
      }
    });
  });

  document.querySelectorAll('.panel-handle').forEach((button) => {
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      const panel = document.getElementById(button.getAttribute('data-target'));
      if (!panel || panel.classList.contains('pinned')) return;
      panel.classList.toggle('collapsed');
    });
  });

  document.querySelectorAll('.edge-sensor').forEach((sensor) => {
    sensor.addEventListener('mouseenter', () => {
      revealPanel(document.getElementById(sensor.getAttribute('data-target')));
    });
  });

  document.querySelectorAll('.overlay.collapsible').forEach((panel) => {
    panel.addEventListener('mouseleave', () => collapsePanel(panel));
  });
}

async function init() {
  setLoading(true, 'Loading stock symbols...');

  try {
    const response = await fetch('/api/symbols');
    if (!response.ok) {
      throw new Error(`Request failed with status ${response.status}`);
    }

    const payload = await response.json();
    const symbols = payload.symbols || [];

    predSymbolSelectEl.innerHTML = symbols
      .map((symbol) => `<option value="${symbol}">${symbol}</option>`)
      .join('');

    setupPanels();
    if (modelSelectEl) {
      modelSelectEl.value = appState.activeModel;
    }
    updateModelControls();

    loadPredBtn.addEventListener('click', loadSelectedPlayback);
    randomRealBtn.addEventListener('click', loadRandomRealPlayback);
    randomPredBtn.addEventListener('click', loadRandomPlayback);
    if (modelSelectEl) {
      modelSelectEl.addEventListener('change', () => {
        appState.activeModel = modelSelectEl.value;
        appState.playback = null;
        appState.frameIndex = 0;
        stopAnimation();
        updateModelControls();
        renderLegend([]);
        setPlaybackPanelVisible(false);
        setStatus(appState.activeModel === 'forecast' ? 'Select a stock and load the forecast model.' : 'Select a stock and load the trading model.');
      });
    }
    focusBtn.addEventListener('click', () => {
      appState.focusCurrent = !appState.focusCurrent;
      updateFocusButton();
      if (appState.playback) {
        drawFrame(appState.frameIndex);
      }
    });
    playBtn.addEventListener('click', play);
    pauseBtn.addEventListener('click', pause);
    resetBtn.addEventListener('click', reset);
    stepBackBtn.addEventListener('click', () => stepFrame(-1));
    stepFwdBtn.addEventListener('click', () => stepFrame(1));

    frameSliderEl.addEventListener('input', () => {
      if (!appState.playback) return;
      stopAnimation();
      appState.frameIndex = Number(frameSliderEl.value);
      drawFrame(appState.frameIndex);
    });

    chartTypeSelectEl.addEventListener('change', () => {
      if (appState.playback) {
        drawFrame(appState.frameIndex);
      }
    });

    speedRangeEl.addEventListener('change', () => {
      if (appState.animationId) {
        play();
      }
    });

    if (forecastRangeEl) {
      forecastRangeEl.addEventListener('input', () => {
        appState.ghostDays = getSelectedForecastDays();
        updateForecastLabel();
        if (appState.playback) {
          drawFrame(appState.frameIndex);
        }
      });
    }

    if (startingCashInputEl) {
      startingCashInputEl.addEventListener('input', () => {
        appState.startingCash = getSelectedStartingCash();
      });
    }

    Plotly.newPlot(chartEl, [], baseLayout('Stock Data Viewer'), { responsive: true });
    appState.ghostDays = getSelectedForecastDays();
    appState.startingCash = getSelectedStartingCash();
    updateForecastLabel();
    updateFocusButton();
    setStatus(appState.activeModel === 'forecast' ? 'Select a stock and click Load Forecast.' : 'Select a stock and click Load Trading.');
    renderLegend([]);
  } catch (error) {
    console.error(error);
    setStatus(`Failed to load: ${error.message}`);
    Plotly.newPlot(chartEl, [], baseLayout('Error'), { responsive: true });
  } finally {
    setLoading(false);
  }
}

init().catch((error) => {
  console.error(error);
  setStatus(`Failed to load: ${error.message}`);
  setLoading(false);
});
