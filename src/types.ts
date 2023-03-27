import { ThorchainAMM, TxSubmitted, Wallet } from "@xchainjs/xchain-thorchain-amm"
import { CryptoAmount } from "@xchainjs/xchain-thorchain-query"
import { Address, Asset } from "@xchainjs/xchain-util"

export type SwapDetail = {
    amount: CryptoAmount
    decimals: number
    fromAsset: Asset
    destinationAsset: Asset
    desstinationAddress: Address
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

export type ExponentialMovingAverage = {
    lastRefreshed: Date
    period: Number
    value: Number
}


export type BotInfo = {
    botMode: BotMode
    walletStatus: string
    dataCollection: Boolean
    startTime: Date
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

export type HighAndLow = {
    high: number,
    low: number
}

export type Signal = {
    type: string
    macd: Boolean
    rsi: Boolean
}

export type SynthBalance = {
    sbusd: CryptoAmount,
    sbtc: CryptoAmount
}