(Work in progress)

# PredictiveStockBot

This is a SciKit-Learn forecast model for Philippine Stock Exchange (PSE) data. 
With a Flask + Plotly web UI so you can for replay of actual historical with bot's predictions against actual prices.

With simulated trading actions (BUY/SELL/HOLD) and portfolio growth 

Data from www.tradingview.com 

## Languages Used

- Python
- JavaScript

## Tech Stack

- Backend: Flask
- ML/Data: scikit-learn
- Frontend charting: Plotly.js

## Main Libraries

- `flask>=3.0.0`
- `pandas>=2.2.0`
- `numpy>=2.0.0`
- `scikit-learn>=1.5.0`
- `joblib>=1.4.0`

## Model Choice and How It Works

This repo currently contains two model pipelines.

### 1) Graph Animation App Models (primary root app)

Used by `graphanimation/app.py` with artifacts in `graphanimation/artifacts/`.

- Forecast model: `RandomForestRegressor`
	- Predicts next close price (`target_close`).
- Trading model: `RandomForestClassifier`
	- Predicts action labels: `BUY`, `SELL`, `HOLD`.

#### Feature Engineering (shared idea across both models)

- Lagged close features (20 days)
- Lagged volume features (10 days)
- Return windows (1, 3, 5, 10)
- Close SMAs (5, 10, 20) and distance-to-SMA
- Volume SMAs (3, 10) and distance-to-SMA
- Symbol categorical encoding

#### Training Design

- Time-based split (chronological) to avoid leakage
- Test period starts from `2022-03-01`
- Forecast and trading are trained as separate tasks

#### Trading Simulation Logic

- `BUY`: invest all available cash
- `SELL`: liquidate all shares
- `HOLD`: keep current cash/shares
- Portfolio value is tracked per step and compared to buy-and-hold

### 2) FinanceBot Stock Viewer Model (secondary app)

Used by `FinanceBot/stock_viewer/app.py` and model artifact metadata in `FinanceBot/export/models/stock_model_single_metadata.json`.

- Selected model: `ExtraTreesRegressor`
- Predicts next-day OHLC ratios (open/high/low/close) from engineered features
- Supports animated next-candle prediction paths in the FinanceBot viewer

## Entry Points

### App Entry Points

- Root interactive playback app: `graphanimation/app.py`
- FinanceBot viewer app: `FinanceBot/stock_viewer/app.py`

### Model Training Entry Point

- Notebook: `model.ipynb`
	- Trains and exports forecast + trading artifacts used by `graphanimation/app.py`

### Important API Routes (graphanimation)

- `GET /api/symbols`
- `GET /api/playback?symbol=...&model=forecast|trading`
- `GET /api/random_playback`
- `GET /api/random_real_playback?model=forecast|trading`

## Setup

### 1) Clone and enter project

```bash
git clone https://github.com/RenceCLM/PredictiveStockBot.git
cd PredictiveStockBot
```

### 2) Create and activate a virtual environment

```bash
python3 -m venv .venv
source .venv/bin/activate
```

### 3) Install dependencies

```bash
pip install -r requirements.txt
```

### 4) Ensure model artifacts exist

If `graphanimation/artifacts/` is missing model files, open and run all cells in `model.ipynb` to generate:

- `forecast_model.joblib`
- `forecast_predictions.csv`
- `forecast_metrics.json`
- `trading_model.joblib`
- `trading_backtest.csv`
- `trading_metrics.json`
- `metrics.json`

### 5) Run the main app

```bash
python graphanimation/app.py
```

Then open:

- `http://127.0.0.1:5000/`

## Optional: Run the FinanceBot Viewer

```bash
python FinanceBot/stock_viewer/app.py
```

Then open:

- `http://127.0.0.1:8080/`

## Project Structure (High-Level)

- `model.ipynb`: training notebook for root app models
- `graphanimation/app.py`: main Flask + Plotly playback app
- `graphanimation/artifacts/`: saved models, predictions, metrics
- `data/pse_multistock_ohlcv.csv`: source dataset
- `FinanceBot/export/models/`: FinanceBot trained model artifacts

## Notes

- The repository includes multiple experiments/apps (`graphanimation`, `FinanceBot`, and `tradingview-scraper`).
