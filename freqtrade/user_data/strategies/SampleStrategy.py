# pragma pylint: disable=missing-docstring, invalid-name, pointless-string-statement
# sys.path.append(os.path.dirname(__file__))

import numpy as np
import pandas as pd
from pandas import DataFrame
from freqtrade.strategy import IStrategy

# --------------------------------------------------------------------------------   
# Standard technical indicators
import talib.abstract as ta
import freqtrade.vendor.qtpylib.indicators as qtpylib

class SampleStrategy(IStrategy):
    """
    Standard EMA/RSI Crossover Strategy for Freqtrade.
    Matches timeframe of WECRYPTO (5m indicators).
    """
    # Strategy interface version - do not modify
    INTERFACE_VERSION = 3

    # Timeframe used by the strategy
    timeframe = '5m'

    # Can this strategy go short?
    can_short: bool = False

    # Minimal ROI designed for taking profit
    minimal_roi = {
        "60": 0.01,
        "30": 0.02,
        "0": 0.05
    }

    # Stoploss: 10%
    stoploss = -0.10

    # Trailing stoploss
    trailing_stop = False

    # Run populate_indicators on new candle only
    process_only_new_candles = True

    # Number of candles the strategy requires before starting indicators
    startup_candle_count: int = 30

    def populate_indicators(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        # RSI
        dataframe['rsi'] = ta.RSI(dataframe, timeperiod=14)

        # EMAs
        dataframe['ema9'] = ta.EMA(dataframe, timeperiod=9)
        dataframe['ema21'] = ta.EMA(dataframe, timeperiod=21)

        return dataframe

    def populate_entry_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe['rsi'] < 30) &  # Oversold RSI
                (qtpylib.crossed_above(dataframe['ema9'], dataframe['ema21']))  # Bullish EMA cross
            ),
            'enter_long'] = 1

        return dataframe

    def populate_exit_trend(self, dataframe: DataFrame, metadata: dict) -> DataFrame:
        dataframe.loc[
            (
                (dataframe['rsi'] > 70) |  # Overbought RSI
                (qtpylib.crossed_below(dataframe['ema9'], dataframe['ema21']))  # Bearish EMA cross
            ),
            'exit_long'] = 1

        return dataframe
