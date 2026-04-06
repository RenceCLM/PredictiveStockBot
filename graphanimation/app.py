from __future__ import annotations

import copy
import json
import random
from functools import lru_cache
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from flask import Flask, jsonify, render_template, request


BASE_DIR = Path(__file__).resolve().parent
DATA_PATH = BASE_DIR.parents[0] / "data" / "pse_multistock_ohlcv.csv"
ARTIFACT_DIR = BASE_DIR / "artifacts"
FORECAST_MODEL_PATH = ARTIFACT_DIR / "forecast_model.joblib"
FORECAST_PREDICTIONS_PATH = ARTIFACT_DIR / "forecast_predictions.csv"
FORECAST_METRICS_PATH = ARTIFACT_DIR / "forecast_metrics.json"
TRADING_MODEL_PATH = ARTIFACT_DIR / "trading_model.joblib"
TRADING_METRICS_PATH = ARTIFACT_DIR / "trading_metrics.json"
METRICS_PATH = ARTIFACT_DIR / "metrics.json"

# Backward-compatible aliases used by the forecast playback code.
MODEL_PATH = FORECAST_MODEL_PATH
PREDICTIONS_PATH = FORECAST_PREDICTIONS_PATH
FORECAST_HORIZON = 5
MAX_FORECAST_HORIZON = 20
TEST_START_DATE = pd.Timestamp("2022-03-01")
PRICE_LAG_DAYS = 20
VOLUME_LAG_DAYS = 10
RETURN_WINDOWS = (1, 3, 5, 10)
SMA_CLOSE_WINDOWS = (5, 10, 20)
SMA_VOLUME_WINDOWS = (3, 10)


app = Flask(__name__)


@lru_cache(maxsize=1)
def _load_price_data_cached() -> pd.DataFrame:
	df = pd.read_csv(DATA_PATH)
	df["date"] = pd.to_datetime(df["date"])
	return df.sort_values(["symbol", "date"]).reset_index(drop=True)


def load_price_data() -> pd.DataFrame:
	# Return a copy so callers can mutate safely without polluting the cache.
	return _load_price_data_cached().copy()


@lru_cache(maxsize=1)
def _load_predictions_cached() -> pd.DataFrame:
	if not PREDICTIONS_PATH.exists():
		raise FileNotFoundError(
			"Prediction file not found. Run model.ipynb first to generate artifacts."
		)

	pred_df = pd.read_csv(PREDICTIONS_PATH)
	pred_df["date"] = pd.to_datetime(pred_df["date"])
	return pred_df.sort_values(["symbol", "date"]).reset_index(drop=True)


def load_predictions() -> pd.DataFrame:
	# Return a copy so callers can mutate safely without polluting the cache.
	return _load_predictions_cached().copy()


@lru_cache(maxsize=1)
def load_model():
	if not MODEL_PATH.exists():
		raise FileNotFoundError(
			"Model file not found. Run model.ipynb first to generate artifacts."
		)
	return joblib.load(MODEL_PATH)


@lru_cache(maxsize=1)
def load_trading_model():
	if not TRADING_MODEL_PATH.exists():
		raise FileNotFoundError(
			"Trading model file not found. Run model.ipynb first to generate artifacts."
		)
	return joblib.load(TRADING_MODEL_PATH)


def make_feature_row(symbol: str, closes: list[float], volumes: list[float]) -> pd.DataFrame:
	if len(closes) < PRICE_LAG_DAYS or len(volumes) < VOLUME_LAG_DAYS:
		raise ValueError("Not enough history to build forecast features.")

	row: dict[str, float | str] = {"symbol": symbol}
	for lag in range(1, PRICE_LAG_DAYS + 1):
		row[f"lag_close_{lag}"] = float(closes[-lag])
	for lag in range(1, VOLUME_LAG_DAYS + 1):
		row[f"lag_volume_{lag}"] = float(volumes[-lag])

	latest_close = float(closes[-1])
	latest_volume = float(volumes[-1])
	for window in RETURN_WINDOWS:
		row[f"return_{window}"] = float(closes[-1] / closes[-(window + 1)] - 1.0)

	for window in SMA_CLOSE_WINDOWS:
		sma = float(np.mean(closes[-window:]))
		row[f"sma_close_{window}"] = sma
		row[f"close_vs_sma_{window}"] = float(latest_close / sma - 1.0) if sma else 0.0

	for window in SMA_VOLUME_WINDOWS:
		sma = float(np.mean(volumes[-window:]))
		row[f"sma_volume_{window}"] = sma
		row[f"volume_vs_sma_{window}"] = float(latest_volume / sma - 1.0) if sma else 0.0

	return pd.DataFrame([row])


def build_feature_frame(symbol_prices: pd.DataFrame) -> pd.DataFrame:
	work = symbol_prices.copy()
	work["date"] = pd.to_datetime(work["date"])
	work = work.sort_values(["symbol", "date"]).reset_index(drop=True)

	for lag in range(1, PRICE_LAG_DAYS + 1):
		work[f"lag_close_{lag}"] = work.groupby("symbol")["close"].shift(lag)
	for lag in range(1, VOLUME_LAG_DAYS + 1):
		work[f"lag_volume_{lag}"] = work.groupby("symbol")["volume"].shift(lag)

	for window in RETURN_WINDOWS:
		work[f"return_{window}"] = work[f"lag_close_1"] / work[f"lag_close_{window + 1}"] - 1.0

	for window in SMA_CLOSE_WINDOWS:
		close_lag_cols = [f"lag_close_{i}" for i in range(1, window + 1)]
		work[f"sma_close_{window}"] = work[close_lag_cols].mean(axis=1)
		work[f"close_vs_sma_{window}"] = work[f"lag_close_1"] / work[f"sma_close_{window}"] - 1.0

	for window in SMA_VOLUME_WINDOWS:
		volume_lag_cols = [f"lag_volume_{i}" for i in range(1, window + 1)]
		work[f"sma_volume_{window}"] = work[volume_lag_cols].mean(axis=1)
		work[f"volume_vs_sma_{window}"] = work[f"lag_volume_1"] / work[f"sma_volume_{window}"] - 1.0

	work = work.rename(columns={"close": "target_close"})

	keep_cols = [
		"date",
		"symbol",
		"target_close",
	] + [
		column
		for column in work.columns
		if column.startswith("lag_close_")
		or column.startswith("lag_volume_")
		or column.startswith("return_")
		or column.startswith("sma_close_")
		or column.startswith("close_vs_sma_")
		or column.startswith("sma_volume_")
		or column.startswith("volume_vs_sma_")
	]

	return work[keep_cols].dropna().reset_index(drop=True)


def simulate_trading_path(rows: pd.DataFrame, predicted_actions: np.ndarray, starting_cash: float) -> pd.DataFrame:
	cash = float(starting_cash)
	shares = 0.0
	records: list[dict[str, float | str]] = []

	if rows.empty:
		return pd.DataFrame()

	first_price = float(rows["target_close"].iloc[0])
	buy_hold_shares = starting_cash / first_price if first_price > 0 else 0.0

	for row_index, (_, row) in enumerate(rows.iterrows()):
		price = float(row["target_close"])
		action = str(predicted_actions[row_index])
		if action == "BUY" and cash > 0 and price > 0:
			shares += cash / price
			cash = 0.0
		elif action == "SELL" and shares > 0:
			cash += shares * price
			shares = 0.0

		portfolio_value = cash + shares * price
		buy_hold_value = buy_hold_shares * price
		records.append(
			{
				"date": row["date"],
				"symbol": row["symbol"],
				"target_close": price,
				"action": action,
				"cash": float(cash),
				"shares": float(shares),
				"portfolio_value": float(portfolio_value),
				"buy_hold_value": float(buy_hold_value),
			}
		)

	return pd.DataFrame(records)


def build_recursive_forecast_paths(
	symbol: str,
	dates: pd.Series,
	closes: pd.Series,
	volumes: pd.Series,
	start_index: int,
	horizon: int = FORECAST_HORIZON,
) -> tuple[list[list[str]], list[list[float]], list[str]]:
	model = load_model()
	date_values = pd.to_datetime(dates)
	close_arr = closes.astype(float).to_numpy()
	volume_arr = volumes.astype(float).to_numpy()

	if len(close_arr) == 0 or start_index >= len(close_arr):
		return [], [], []

	if start_index < max(PRICE_LAG_DAYS - 1, VOLUME_LAG_DAYS - 1):
		raise ValueError("Not enough history to build forecast features.")

	n_paths = len(close_arr) - start_index
	path_indices = np.arange(start_index, len(close_arr))
	close_lags = {
		lag: close_arr[path_indices - (lag - 1)].copy() for lag in range(1, PRICE_LAG_DAYS + 1)
	}
	volume_lags = {
		lag: volume_arr[path_indices - (lag - 1)].copy() for lag in range(1, VOLUME_LAG_DAYS + 1)
	}

	current_dates = pd.DatetimeIndex(date_values.iloc[path_indices])
	forecast_feed_dates = [d.strftime("%Y-%m-%d") for d in current_dates]

	forecast_close_steps: list[np.ndarray] = []
	forecast_date_steps: list[np.ndarray] = []

	for _ in range(horizon):
		feature_data: dict[str, np.ndarray | list[str]] = {"symbol": [symbol] * n_paths}
		for lag in range(1, PRICE_LAG_DAYS + 1):
			feature_data[f"lag_close_{lag}"] = close_lags[lag]
		for lag in range(1, VOLUME_LAG_DAYS + 1):
			feature_data[f"lag_volume_{lag}"] = volume_lags[lag]

		for window in RETURN_WINDOWS:
			feature_data[f"return_{window}"] = close_lags[1] / close_lags[window + 1] - 1.0

		for window in SMA_CLOSE_WINDOWS:
			sma = sum(close_lags[i] for i in range(1, window + 1)) / float(window)
			feature_data[f"sma_close_{window}"] = sma
			feature_data[f"close_vs_sma_{window}"] = np.where(sma != 0.0, close_lags[1] / sma - 1.0, 0.0)

		for window in SMA_VOLUME_WINDOWS:
			sma = sum(volume_lags[i] for i in range(1, window + 1)) / float(window)
			feature_data[f"sma_volume_{window}"] = sma
			feature_data[f"volume_vs_sma_{window}"] = np.where(sma != 0.0, volume_lags[1] / sma - 1.0, 0.0)

		feature_rows = pd.DataFrame(feature_data)

		next_close = model.predict(feature_rows).astype(float)
		next_close = np.maximum(0.01, next_close)

		current_dates = current_dates + pd.offsets.BDay(1)
		forecast_date_steps.append(current_dates.strftime("%Y-%m-%d").to_numpy())
		forecast_close_steps.append(np.round(next_close, 4))

		for lag in range(PRICE_LAG_DAYS, 1, -1):
			close_lags[lag] = close_lags[lag - 1]
		close_lags[1] = next_close

		next_volume = volume_lags[1]
		for lag in range(VOLUME_LAG_DAYS, 1, -1):
			volume_lags[lag] = volume_lags[lag - 1]
		volume_lags[1] = next_volume

	forecast_dates_paths = np.stack(forecast_date_steps, axis=1).tolist()
	forecast_close_paths = np.stack(forecast_close_steps, axis=1).tolist()
	return forecast_dates_paths, forecast_close_paths, forecast_feed_dates


def parse_requested_horizon(raw: str | None) -> int:
	if raw is None:
		return FORECAST_HORIZON

	raw = raw.strip()
	if not raw:
		return FORECAST_HORIZON

	try:
		horizon = int(raw)
	except ValueError:
		return FORECAST_HORIZON

	return max(1, min(MAX_FORECAST_HORIZON, horizon))


def parse_starting_cash(raw: str | None) -> float:
	if raw is None:
		return 100_000.0

	raw = raw.strip().replace(",", "")
	if not raw:
		return 100_000.0

	try:
		amount = float(raw)
	except ValueError:
		return 100_000.0

	return max(1.0, amount)


@lru_cache(maxsize=256)
def get_cached_playback_payload(symbol: str, horizon: int = FORECAST_HORIZON) -> dict:
	symbol = symbol.strip().upper()
	prices = load_price_data()
	preds = load_predictions()

	symbol_prices = prices[prices["symbol"] == symbol].copy()
	symbol_preds = preds[preds["symbol"] == symbol].copy()

	if symbol_prices.empty:
		raise ValueError(f"Symbol {symbol} not found in source data.")
	if symbol_preds.empty:
		raise ValueError(f"Symbol {symbol} has no prediction rows.")

	symbol_prices = symbol_prices.sort_values("date")
	symbol_preds = symbol_preds.sort_values("date")
	return build_playback_payload(symbol_prices, symbol_preds, symbol, horizon=horizon)


def build_playback_payload(
	symbol_prices: pd.DataFrame,
	symbol_preds: pd.DataFrame,
	symbol: str,
	horizon: int = FORECAST_HORIZON,
) -> dict:
	symbol_prices = symbol_prices.sort_values("date").reset_index(drop=True)
	symbol_preds = symbol_preds.sort_values("date").reset_index(drop=True)

	first_test_date = symbol_preds["date"].min()
	first_test_idx_series = symbol_prices.index[symbol_prices["date"] >= first_test_date]
	first_test_idx = 0 if len(first_test_idx_series) == 0 else int(first_test_idx_series[0])
	forecast_dates_paths, forecast_close_paths, forecast_feed_dates = build_recursive_forecast_paths(
		symbol=symbol,
		dates=symbol_prices["date"],
		closes=symbol_prices["close"],
		volumes=symbol_prices["volume"],
		start_index=first_test_idx,
		horizon=horizon,
	)

	return {
		"symbol": symbol,
		"history_dates": symbol_prices["date"].dt.strftime("%Y-%m-%d").tolist(),
		"history_open": symbol_prices["open"].astype(float).round(4).tolist(),
		"history_high": symbol_prices["high"].astype(float).round(4).tolist(),
		"history_low": symbol_prices["low"].astype(float).round(4).tolist(),
		"history_close": symbol_prices["close"].astype(float).round(4).tolist(),
		"test_dates": symbol_preds["date"].dt.strftime("%Y-%m-%d").tolist(),
		"test_actual": symbol_preds["target_close"].astype(float).round(4).tolist(),
		"test_pred": symbol_preds["pred_close"].astype(float).round(4).tolist(),
		"test_start_index": first_test_idx,
		"forecast_dates_paths": forecast_dates_paths,
		"forecast_close_paths": forecast_close_paths,
		"forecast_feed_dates": forecast_feed_dates,
	}


def build_trading_payload(symbol_prices: pd.DataFrame, symbol: str, starting_cash: float) -> dict:
	trading_model = load_trading_model()
	symbol_prices = symbol_prices.sort_values("date").reset_index(drop=True)
	feature_frame = build_feature_frame(symbol_prices)
	feature_frame = feature_frame[feature_frame["date"] >= TEST_START_DATE].reset_index(drop=True)

	if feature_frame.empty:
		raise ValueError(f"Symbol {symbol} has no trading rows on or after the test start date.")

	x_data = feature_frame[["symbol"] + [
		column
		for column in feature_frame.columns
		if column.startswith("lag_close_")
		or column.startswith("lag_volume_")
		or column.startswith("return_")
		or column.startswith("sma_close_")
		or column.startswith("close_vs_sma_")
		or column.startswith("sma_volume_")
		or column.startswith("volume_vs_sma_")
	]]
	predicted_actions = trading_model.predict(x_data)
	backtest = simulate_trading_path(feature_frame, predicted_actions, starting_cash)

	if backtest.empty:
		raise ValueError(f"Unable to simulate trading path for symbol {symbol}.")

	backtest["predicted_action"] = predicted_actions
	first_test_idx_series = symbol_prices.index[symbol_prices["date"] >= feature_frame["date"].min()]
	first_test_idx = 0 if len(first_test_idx_series) == 0 else int(first_test_idx_series[0])

	return {
		"model": "trading",
		"symbol": symbol,
		"starting_cash": float(starting_cash),
		"history_dates": symbol_prices["date"].dt.strftime("%Y-%m-%d").tolist(),
		"history_open": symbol_prices["open"].astype(float).round(4).tolist(),
		"history_high": symbol_prices["high"].astype(float).round(4).tolist(),
		"history_low": symbol_prices["low"].astype(float).round(4).tolist(),
		"history_close": symbol_prices["close"].astype(float).round(4).tolist(),
		"test_dates": backtest["date"].dt.strftime("%Y-%m-%d").tolist(),
		"test_actions": backtest["action"].tolist(),
		"test_pred_actions": backtest["predicted_action"].tolist(),
		"test_target_close": backtest["target_close"].astype(float).round(4).tolist(),
		"test_cash": backtest["cash"].astype(float).round(4).tolist(),
		"test_shares": backtest["shares"].astype(float).round(6).tolist(),
		"test_portfolio_value": backtest["portfolio_value"].astype(float).round(4).tolist(),
		"buy_hold_value": backtest["buy_hold_value"].astype(float).round(4).tolist(),
		"test_start_index": first_test_idx,
		"action_counts": {label: int(count) for label, count in pd.Series(predicted_actions).value_counts().items()},
	}


def build_random_window_payload(
	payload: dict,
	min_future_points: int = 40,
	max_future_points: int = 220,
	history_points: int = 260,
) -> dict:
	test_dates = payload.get("test_dates", [])
	test_actual = payload.get("test_actual", [])
	test_pred = payload.get("test_pred", [])
	test_start_index = int(payload.get("test_start_index", 0))

	n_test = len(test_dates)
	if n_test <= min_future_points:
		start_idx = 0
		end_idx = n_test
	else:
		start_idx = random.randint(0, n_test - min_future_points)
		max_len = min(max_future_points, n_test - start_idx)
		win_len = random.randint(min_future_points, max_len)
		end_idx = start_idx + win_len

	if end_idx <= start_idx:
		start_idx = 0
		end_idx = n_test

	absolute_test_start = test_start_index + start_idx
	absolute_test_end = test_start_index + end_idx - 1
	history_start = max(0, absolute_test_start - history_points)

	history_keys = ["history_dates", "history_open", "history_high", "history_low", "history_close", "history_volume"]
	window_payload = {"symbol": payload["symbol"]}
	for key in history_keys:
		series = payload.get(key, [])
		window_payload[key] = series[history_start : absolute_test_end + 1]

	window_payload["test_dates"] = test_dates[start_idx:end_idx]
	window_payload["test_actual"] = test_actual[start_idx:end_idx]
	window_payload["test_pred"] = test_pred[start_idx:end_idx]
	window_payload["test_start_index"] = absolute_test_start - history_start
	window_payload["forecast_dates_paths"] = payload.get("forecast_dates_paths", [])[start_idx:end_idx]
	window_payload["forecast_close_paths"] = payload.get("forecast_close_paths", [])[start_idx:end_idx]
	window_payload["forecast_feed_dates"] = payload.get("forecast_feed_dates", [])[start_idx:end_idx]
	window_payload["random_window"] = {
		"start_date": test_dates[start_idx] if n_test else "",
		"end_date": test_dates[end_idx - 1] if n_test else "",
		"n_test_points": int(max(0, end_idx - start_idx)),
	}
	return window_payload


def _random_symbol() -> str:
	letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
	return "RND-" + "".join(random.choice(letters) for _ in range(3))


def _estimate_symbol_stats(symbol_prices: pd.DataFrame) -> tuple[float, float, float]:
	closes = symbol_prices["close"].astype(float).to_numpy()
	base = float(closes[-1]) if len(closes) else 100.0
	returns = pd.Series(closes).pct_change().dropna()
	volatility = float(returns.std()) if not returns.empty else 0.01
	volatility = max(0.004, min(volatility, 0.03))
	trend = float(returns.tail(20).mean()) if len(returns) else 0.0
	trend = max(-0.01, min(trend, 0.01))
	return base, volatility, trend


def build_synthetic_payload_from_stock(
	stock_symbol: str,
	base_price: float,
	volatility: float,
	trend: float,
	n_points: int = 320,
	history_points: int = 230,
	horizon: int = FORECAST_HORIZON,
	seed: int | None = None,
) -> dict:
	if seed is not None:
		random.seed(seed)

	dates = pd.bdate_range(end=pd.Timestamp.today().normalize(), periods=n_points)

	open_vals: list[float] = []
	high_vals: list[float] = []
	low_vals: list[float] = []
	close_vals: list[float] = []
	volume_vals: list[float] = []

	prev_close = base_price
	for _ in range(n_points):
		drift = trend + random.gauss(0.0, volatility * 0.18)
		ret = drift + random.gauss(0.0, volatility)
		close = max(2.0, prev_close * (1.0 + ret))
		open_price = max(2.0, prev_close * (1.0 + random.gauss(0.0, volatility / 2.2)))

		high_anchor = max(open_price, close)
		low_anchor = min(open_price, close)
		high = high_anchor * (1.0 + abs(random.gauss(0.002, volatility / 1.6)))
		low = max(1.0, low_anchor * (1.0 - abs(random.gauss(0.002, volatility / 1.6))))
		volume = max(1000.0, abs(random.gauss(450000.0, 180000.0)))

		open_vals.append(round(open_price, 4))
		high_vals.append(round(high, 4))
		low_vals.append(round(low, 4))
		close_vals.append(round(close, 4))
		volume_vals.append(round(volume, 2))
		prev_close = close

	test_start_index = max(40, min(history_points, n_points - 20))
	test_dates = dates[test_start_index:]
	test_actual = close_vals[test_start_index:]

	test_pred: list[float] = []
	for i, actual in enumerate(test_actual):
		if i == 0:
			pred = actual * (1.0 + random.gauss(0.0, 0.008))
		else:
			window_start = max(0, test_start_index + i - 5)
			window = close_vals[window_start : test_start_index + i]
			if len(window) >= 2 and window[-2] > 0:
				local_trend = (window[-1] - window[-2]) / window[-2]
			else:
				local_trend = 0.0

			baseline = test_pred[-1] * (1.0 + 0.65 * local_trend)
			correction = 0.18 * (actual - baseline)
			noise = random.gauss(0.0, max(0.05, baseline * 0.004))
			pred = baseline + correction + noise

		test_pred.append(round(max(1.0, pred), 4))

	payload = {
		"symbol": stock_symbol,
		"history_dates": [d.strftime("%Y-%m-%d") for d in dates],
		"history_open": open_vals,
		"history_high": high_vals,
		"history_low": low_vals,
		"history_close": close_vals,
		"history_volume": volume_vals,
		"test_dates": [d.strftime("%Y-%m-%d") for d in test_dates],
		"test_actual": [float(x) for x in test_actual],
		"test_pred": [float(x) for x in test_pred],
		"test_start_index": int(test_start_index),
		"random_window": {
			"start_date": test_dates[0].strftime("%Y-%m-%d"),
			"end_date": test_dates[-1].strftime("%Y-%m-%d"),
			"n_test_points": int(len(test_dates)),
			"synthetic": True,
		},
	}
	forecast_dates_paths, forecast_close_paths, forecast_feed_dates = build_recursive_forecast_paths(
		symbol=stock_symbol,
		dates=pd.Series(dates),
		closes=pd.Series(close_vals),
		volumes=pd.Series(volume_vals),
		start_index=test_start_index,
		horizon=horizon,
	)
	payload["forecast_dates_paths"] = forecast_dates_paths
	payload["forecast_close_paths"] = forecast_close_paths
	payload["forecast_feed_dates"] = forecast_feed_dates
	return payload


def build_synthetic_random_payload(
	n_points: int = 320,
	history_points: int = 230,
	horizon: int = FORECAST_HORIZON,
	seed: int | None = None,
) -> dict:
	prices = load_price_data()
	symbols = sorted(prices["symbol"].unique().tolist())
	chosen_symbol = random.choice(symbols)
	symbol_prices = prices[prices["symbol"] == chosen_symbol].copy()
	base_price, volatility, trend = _estimate_symbol_stats(symbol_prices)
	return build_synthetic_payload_from_stock(
		stock_symbol=chosen_symbol,
		base_price=base_price,
		volatility=volatility,
		trend=trend,
		n_points=n_points,
		history_points=history_points,
		horizon=horizon,
		seed=seed,
	)


@app.route("/")
def index():
	df = load_price_data()
	symbols = sorted(df["symbol"].unique().tolist())

	metrics = {}
	if METRICS_PATH.exists():
		metrics = json.loads(METRICS_PATH.read_text(encoding="utf-8"))

	return render_template("index.html", symbols=symbols, metrics=metrics)


@app.route("/api/symbols")
def api_symbols():
	df = load_price_data()
	symbols = sorted(df["symbol"].unique().tolist())
	return jsonify({"symbols": symbols})


@app.route("/api/playback")
def api_playback():
	symbol = request.args.get("symbol", "").strip().upper()
	if not symbol:
		return jsonify({"error": "Please provide a symbol query parameter."}), 400
	model_type = request.args.get("model", "trading").strip().lower()

	if model_type == "forecast":
		horizon = parse_requested_horizon(request.args.get("horizon"))
		try:
			payload = copy.deepcopy(get_cached_playback_payload(symbol, horizon))
		except ValueError as exc:
			message = str(exc)
			status = 404 if "not found" in message or "no prediction" in message else 400
			return jsonify({"error": message}), status
		return jsonify(payload)

	starting_cash = parse_starting_cash(request.args.get("starting_cash"))
	prices = load_price_data()
	symbol_prices = prices[prices["symbol"] == symbol].copy()
	if symbol_prices.empty:
		return jsonify({"error": f"Symbol {symbol} not found in source data."}), 404

	try:
		payload = build_trading_payload(symbol_prices, symbol, starting_cash)
	except ValueError as exc:
		return jsonify({"error": str(exc)}), 400

	return jsonify(payload)


@app.route("/api/random_playback")
def api_random_playback():
	seed_param = request.args.get("seed", "").strip()
	seed = int(seed_param) if seed_param.isdigit() else None
	horizon = parse_requested_horizon(request.args.get("horizon"))
	payload = build_synthetic_random_payload(seed=seed, horizon=horizon)
	return jsonify(payload)


@app.route("/api/random_real_playback")
def api_random_real_playback():
	preds = load_predictions()
	prices = load_price_data()
	model_type = request.args.get("model", "trading").strip().lower()
	starting_cash = parse_starting_cash(request.args.get("starting_cash"))
	horizon = parse_requested_horizon(request.args.get("horizon"))

	if model_type == "forecast":
		available_symbols = sorted(set(preds["symbol"].unique().tolist()))
		if not available_symbols:
			return jsonify({"error": "No prediction data available."}), 404

		random.shuffle(available_symbols)
		chosen_symbol = None
		for candidate in available_symbols:
			if len(preds[preds["symbol"] == candidate]) >= 20:
				chosen_symbol = candidate
				break

		if chosen_symbol is None:
			return jsonify({"error": "No symbol has enough prediction rows for random playback."}), 404

		full_payload = copy.deepcopy(get_cached_playback_payload(chosen_symbol, horizon))
		payload = build_random_window_payload(full_payload)
		payload["random_window"]["synthetic"] = False
		return jsonify(payload)

	available_symbols = sorted(set(prices["symbol"].unique().tolist()))
	if not available_symbols:
		return jsonify({"error": "No price data available."}), 404

	random.shuffle(available_symbols)
	chosen_symbol = None
	for candidate in available_symbols:
		if len(prices[prices["symbol"] == candidate]) >= 30:
			chosen_symbol = candidate
			break

	if chosen_symbol is None:
		return jsonify({"error": "No symbol has enough price history for random trading playback."}), 404

	symbol_prices = prices[prices["symbol"] == chosen_symbol].copy()
	try:
		payload = build_trading_payload(symbol_prices, chosen_symbol, starting_cash)
	except ValueError as exc:
		return jsonify({"error": str(exc)}), 400

	payload["random_window"] = {
		"start_date": payload["test_dates"][0],
		"end_date": payload["test_dates"][-1],
		"n_test_points": int(len(payload["test_dates"])),
		"synthetic": False,
	}
	return jsonify(payload)


if __name__ == "__main__":
	app.run(debug=True)
