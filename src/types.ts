import { ThorchainAMM, TxSubmitted, Wallet } from "@xchainjs/xchain-thorchain-amm"
import { CryptoAmount } from "@xchainjs/xchain-thorchain-query"
import { Address, Asset } from "@xchainjs/xchain-util"

export type SwapDetail = {
    amount: CryptoAmount
    decimals: number
    fromAsset: Asset
    destinationAsset: Asset
}

export type TradingWallet = {
    wallet: Wallet,
    thorchainAmm: ThorchainAMM
}
export type TxDetail = {
    date: Date
    action: string
    assetPrice: number
    asset: Asset
    amount: string
    result: TxSubmitted | string
    rsi: number
  }

export enum BotMode {
    paused = 'paused',
    runLiveTrading = 'runLiveTrading',
    runIdle = 'runIdle',
    stop = 'stop'
}
export enum TradingMode {
    buy = 'buy',
    sell = 'sell',
    hold = 'hold',
    paused = 'paused',
}


export type ExponentialMovingAverage = {
    lastRefreshed: Date
    period: Number
    value: Number
}

export type MacdResult = {
    macdLine: number[]
    signalLine: number[]
    histogram: number[]
}


export type BotInfo = {
    botMode: BotMode
    walletStatus: string
    dataCollection: Boolean
    startTime: Date
    tradingMode: TradingMode
}

export enum ChartInterval {
    OneMinute = `1m`,
    FiveMinute = `5m`,
    FifteenMinute = `15m`,
    HalfHour = `30m`,
    OneHour = `1h`
}

export type PriceData = {
    asset: Asset
    interval: string
    time: Date
}

export type Action = {
    action: string
    price: PriceData
    rsi: number
}
export type Time = {
    timeInSeconds: Number,
    timeInMinutes: Number,
    timeInHours: Number,
}

export type Signal = {
    type: TradingMode
    macd: Boolean
    rsi: Boolean
    histogram: Boolean
    decision: string
}

export type SynthBalance = {
    sbusd: CryptoAmount,
    sbtc: CryptoAmount,
    sbtcb: CryptoAmount,
}

export type ParabolicSar = {
    trends: Trend[],
    psar: number[]
}

export declare enum Trend {
    FALLING = -1,
    STABLE = 0,
    RISING = 1
}

export declare enum Trends {
    BULLISH = "Bullish trend",
    BEARISH = "Bearish trend",
    NEUTRAL = "Neutral trend"
  }


export type HighAndLow = {
    high: number[],
    low: number[]
}

export type TradeAnalysis = {
    tradeSignal: string
    tradeType: TradingMode
}