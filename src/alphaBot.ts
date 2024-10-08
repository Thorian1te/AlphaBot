import * as fs from 'fs'

import { Client as AvaxClient, defaultAvaxParams } from '@xchainjs/xchain-avax'
import { Client as BtcClient, defaultBTCParams as defaultBtcParams } from '@xchainjs/xchain-bitcoin'
import { Client as BchClient, defaultBchParams } from '@xchainjs/xchain-bitcoincash'
import { Client as BscClient, defaultBscParams } from '@xchainjs/xchain-bsc'
import { Client as GaiaClient } from '@xchainjs/xchain-cosmos'
import { Client as DogeClient, defaultDogeParams } from '@xchainjs/xchain-doge'
import { Client as EthClient, defaultEthParams } from '@xchainjs/xchain-ethereum'
import { Client as LtcClient, defaultLtcParams } from '@xchainjs/xchain-litecoin'
import { Client as ThorClient, defaultClientConfig as defaultThorParams } from '@xchainjs/xchain-thorchain'

import { ThorchainAMM } from '@xchainjs/xchain-thorchain-amm'
import { Wallet } from '@xchainjs/xchain-wallet'
import { Midgard, MidgardCache, MidgardQuery } from '@xchainjs/xchain-midgard-query'
import { ThorchainCache, ThorchainQuery, Thornode } from '@xchainjs/xchain-thorchain-query'
import { decryptFromKeystore } from '@xchainjs/xchain-crypto'
import { Network } from '@xchainjs/xchain-client'
import { THORChain } from '@xchainjs/xchain-thorchain'
import {
  CryptoAmount,
  assetAmount,
  assetFromStringEx,
  delay,
  assetToBase,
  Asset,
  baseAmount,
} from '@xchainjs/xchain-util'
import { doSingleSwap } from './doSwap'
import {
  BotInfo,
  BotMode,
  ChartInterval,
  MacdResult,
  Signal,
  SwapDetail,
  SynthBalance,
  Time,
  TradingMode,
  TradingWallet,
  TxDetail,
} from './types'
import { TradingIndicators } from './tradingIndicators'

require('dotenv').config()

const assetsBUSD = assetFromStringEx(`BNB/BUSD-BD1`)
const assetsBTC = assetFromStringEx(`BTC/BTC`)
const assetsBTCB = assetFromStringEx(`BNB/BTCB-1DE`)

const oneMinuteInMs = 60 * 1000 // 1 minute in milliseconds

// amount to be traded in
const tradingAmount = 1000

const tradePercentage = 0.03 //represented as a number

export const getClients = (seed: string) => ({
  BTC: new BtcClient({ ...defaultBtcParams, phrase: seed }),
  BCH: new BchClient({ ...defaultBchParams, phrase: seed }),
  LTC: new LtcClient({ ...defaultLtcParams, phrase: seed }),
  DOGE: new DogeClient({ ...defaultDogeParams, phrase: seed }),
  ETH: new EthClient({ ...defaultEthParams, phrase: seed }),
  AVAX: new AvaxClient({ ...defaultAvaxParams, phrase: seed }),
  BSC: new BscClient({ ...defaultBscParams, phrase: seed }),
  GAIA: new GaiaClient({ phrase: seed }),
  THOR: new ThorClient({ ...defaultThorParams, phrase: seed }),
})

export class AlphaBot {
  private midgardCache: MidgardCache
  private thorchainCache: ThorchainCache
  private thorchainQuery: ThorchainQuery
  private tradingIndicators: TradingIndicators

  private txRecords: TxDetail[] = []
  private sellOrders: TxDetail[] = []
  private buyOrders: TxDetail[] = []

  public oneMinuteChart: number[] = []
  public fiveMinuteChart: number[] = []
  public fifteenMinuteChart: number[] = []
  public halfHourChart: number[] = []
  public OneHourChart: number[] = []
  public rsi: number[] = []
  private signalTracker: string[] = []

  private thorchainAmm: ThorchainAMM
  private keystore1FilePath: string
  private keystore1Password: string
  private wallet: Wallet | undefined
  private pauseTimeSeconds: number
  private asset: Asset
  private botConfig: BotInfo = {
    botMode: BotMode.runIdle,
    walletStatus: 'initialized',
    dataCollection: true,
    startTime: new Date(),
    tradingMode: TradingMode.hold,
  }
  private interval: number
  private intervalId: NodeJS.Timeout | undefined

  constructor(network: Network, keystore1FilePath: string, keystore1Password: string, pauseTimeSeconds: number) {
    this.keystore1FilePath = keystore1FilePath
    this.keystore1Password = keystore1Password
    this.pauseTimeSeconds = pauseTimeSeconds
    this.midgardCache = new MidgardCache(new Midgard(network))
    this.thorchainCache = new ThorchainCache(new Thornode(network), new MidgardQuery(this.midgardCache))
    this.thorchainQuery = new ThorchainQuery(this.thorchainCache)
    this.thorchainAmm = new ThorchainAMM(this.thorchainQuery)
    this.tradingIndicators = new TradingIndicators()
    this.interval = 10 * 60 * 1000 // 10 minutes in milliseconds
  }

  private async walletSetup() {
    const keystore = JSON.parse(fs.readFileSync(this.keystore1FilePath, 'utf8'))
    const seed = await decryptFromKeystore(keystore, this.keystore1Password)

    this.wallet = new Wallet(getClients(seed))
    this.thorchainAmm = new ThorchainAMM(this.thorchainQuery, this.wallet)
  }

  async start(interval: ChartInterval) {
    console.log(`Start time: ${this.botConfig.startTime}`)
    console.log('Setting up wallet')
    await this.walletSetup()
    console.log('Running AlphaBot....')
    this.schedule()
    try {
      this.readLastBuyTrade()
      this.readLastSellTrade()
    } catch (error) {
      console.log(`Error no previous trades found`)
    }
    while (this.botConfig.botMode !== BotMode.stop) {
      let action: TradingMode
      const tradingHalted = await this.isTradingHalted()
      if (tradingHalted) {
        action = TradingMode.paused
      } else {
        await this.injestTradingData(interval)
      }
    }
    if (this.oneMinuteChart.length > 1080) {
      await this.readFromFile(ChartInterval.OneMinute)
    }
  }

  private async executeAction(action: TradingMode) {
    const tradingWallet = await this.openWallet(this.keystore1Password)
    switch (action) {
      case TradingMode.buy:
        await this.buy(tradingWallet)
        break
      case TradingMode.sell:
        await this.sell(tradingWallet)
        break
      case TradingMode.hold:
        await delay(this.pauseTimeSeconds * 999)
        break
      case TradingMode.paused:
        const tradingHalted = await this.isTradingHalted()
        while (tradingHalted) {
          console.log(`Trading is ${action}, will retry in 10 seconds`)
          await delay(this.pauseTimeSeconds * 10000)
        }
        break
      default:
        break
    }
  }
  private async injestTradingData(interval: string) {
    let market: TradingMode
    let signal: Signal

    await this.tradingIndicators.getRsi(this.fifteenMinuteChart)
    await this.writeToFile(this.tradingIndicators.rsi, 'rsi')

    // find tx records and add them to the cache
    if (this.buyOrders.slice(-1)[0].date > this.sellOrders.slice(-1)[0].date) {
      if (this.txRecords.length < 1) this.txRecords.push(this.buyOrders.slice(-1)[0])
    } else {
      if (this.txRecords.length < 1) this.txRecords.push(this.sellOrders.slice(-1)[0])
    }

    const timeAlive = await this.getTimeDifference(this.botConfig.startTime)
    // dont trade anything for first 1 minutes regardless of if there is a full chart history
    if (this.fiveMinuteChart.length - 1 < 72 || +timeAlive.timeInMinutes <= 1) {
      const percentageComplete = ((this.fiveMinuteChart.length - 1) / 72) * 100
      const log =
        percentageComplete > 100
          ? `Collecting Data, $ ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`
          : `Alphabot is waiting for data maturity: ${percentageComplete.toFixed()} % complete`
      console.log(log)
      await this.executeAction(TradingMode.hold)
    } else {
      console.log(`Collecting trading signals for ${interval}`)
      console.log(`Rsi: ${this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1]}`)
      console.log(`Last Price: ${this.asset.chain} $`, this.oneMinuteChart[this.oneMinuteChart.length - 1])
      const bal = await this.getSynthBalance()
      console.log(bal.sbtc.formatedAssetString())
      console.log(bal.sbtcb.baseAmount !== null ? bal.sbtcb.formatedAssetString() : `BTCB: 0`)
      console.log(bal.sbusd.formatedAssetString())
      try {
        const sbusdworthofbtc = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD)
        const sbusdworthofbtcb = await this.thorchainQuery.convert(bal.sbtcb, assetsBUSD)
        console.log(`Btc in Busd: ${sbusdworthofbtc.formatedAssetString()}`)
        console.log(`BtcB in Busd: ${sbusdworthofbtcb.formatedAssetString()}`)
      } catch (error) {
        console.log(error)
      }

      signal = await this.signal(this.fifteenMinuteChart, 15)
      this.signalTracker.push(
        `${signal.decision}, ${this.asset.chain} $${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`,
      )
      market = await this.checkWalletBal(signal)
      await this.executeAction(market)
    }
  }
  // ----------------------------------- Data collection for intervals -------------------------------
  public async dataCollectionMinute(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC
    console.log(`Collecting ${this.asset.ticker} pool price`)
    await this.readFromFile(interval)
    const highlow = this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart, 1080)
    console.log(`One minute chart highs and lows`, highlow.high.slice(-1), highlow.low.slice(-1))

    while (start) {
      // One minute
      await this.getAssetPrice(interval)
      await this.writeToFile(this.oneMinuteChart, interval)
      await delay(oneMinuteInMs)
      if (this.oneMinuteChart.length > 1080) {
        const excess = this.oneMinuteChart.length - 1080
        this.oneMinuteChart.splice(0, excess)
      }
    }
  }
  public async dataCollectionFiveMinutes(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter((value, index) => (index + 1) % 5 === 0)
      if (this.fiveMinuteChart.length < 1) {
        this.fiveMinuteChart.push(...filtered)
      } else {
        const lastEntryFive = this.fiveMinuteChart[this.fiveMinuteChart.length - 1]
        const lastFilterd = filtered[filtered.length - 1]
        if (lastFilterd !== lastEntryFive) {
          this.fiveMinuteChart.push(lastFilterd)
        }
      }
      await this.writeToFile(this.fiveMinuteChart, interval)
      await delay(oneMinuteInMs * 5)
    }
  }
  public async dataCollectionFifteenMinutes(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter((value, index) => (index + 1) % 15 === 0)
      if (this.fifteenMinuteChart.length < 1) {
        this.fifteenMinuteChart.push(...filtered)
      } else {
        const lastEntryFive = this.fifteenMinuteChart[this.fifteenMinuteChart.length - 1]
        const lastFilterd = filtered[filtered.length - 1]
        if (lastFilterd !== lastEntryFive) {
          this.fifteenMinuteChart.push(lastFilterd)
        }
      }
      await this.writeToFile(this.fifteenMinuteChart, interval)
      await delay(oneMinuteInMs * 15)
    }
  }
  public async dataCollectionHalfHour(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter((value, index) => (index + 1) % 30 === 0)
      if (this.halfHourChart.length < 1) {
        this.halfHourChart.push(...filtered)
      } else {
        const lastEntryFive = this.halfHourChart[this.halfHourChart.length - 1]
        const lastFilterd = filtered[filtered.length - 1]
        if (lastFilterd !== lastEntryFive) {
          this.halfHourChart.push(lastFilterd)
        }
      }
      await this.writeToFile(this.halfHourChart, interval)
      await delay(oneMinuteInMs * 30)
    }
  }
  public async dataCollectionOneHour(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter((value, index) => (index + 1) % 60 === 0)
      if (this.OneHourChart.length < 1) {
        this.OneHourChart.push(...filtered)
      } else {
        const lastEntryFive = this.OneHourChart[this.OneHourChart.length - 1]
        const lastFilterd = filtered[filtered.length - 1]
        if (lastFilterd !== lastEntryFive) {
          this.OneHourChart.push(lastFilterd)
        }
      }
      await this.writeToFile(this.OneHourChart, interval)
      await delay(oneMinuteInMs * 60)
    }
  }
  /** 
/** Fetch price function 
 * 
 * @param chartInterval - chart interval in minutes
 */
  private async getAssetPrice(chartInterval: string) {
    console.log(`Fecthing data at interval ${chartInterval} for asset ${this.asset.ticker}`)
    try {
      const assetPool = await this.thorchainCache.getPoolForAsset(this.asset)
      const assetPrice = Number(assetPool.pool.assetPriceUSD)
      const price = Number(assetPrice.toFixed(2))
      this.oneMinuteChart.push(price)
    } catch (err) {
      console.log(`Error fetching price ${err}`)
    }
  }

  private getTimeDifference(startTime: Date): Time {
    const currentTime = new Date()
    const difference = currentTime.getTime() - startTime.getTime()
    const time: Time = {
      timeInSeconds: difference / 1000,
      timeInMinutes: difference / 1000 / 60,
      timeInHours: difference / 1000 / 60 / 60,
    }
    return time
  }

  private async checkWalletBal(signal: Signal): Promise<TradingMode> {
    const lastTradeTime = new Date(this.txRecords[this.txRecords.length - 1].date)
    const tradeTimeDifference = this.getTimeDifference(lastTradeTime) // add wait of 15 minutes before the next trade.
    const bal = await this.getSynthBalance()
    const hasTxRecords = this.txRecords.length > 0
    try {
      const sbusd = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD)
      const lastAction = this.txRecords[this.txRecords.length - 1].action
      console.log(`Last action: ${this.txRecords[this.txRecords.length - 1].action}`)
      console.log(
        `last trade was: ${tradeTimeDifference.timeInMinutes} ago at price ${
          this.txRecords[this.txRecords.length - 1].assetPrice
        }`,
      )
      console.log(`Signal is: ${signal.decision}`)
      if (signal.type === TradingMode.buy && lastAction != 'buy' && +tradeTimeDifference.timeInMinutes >= 30) {
        console.log(`Spending: `, bal.sbusd.formatedAssetString())
        const decision = bal.sbusd.assetAmount.amount().toNumber() > tradingAmount ? TradingMode.buy : TradingMode.hold
        if (decision == TradingMode.buy) this.signalTracker.push(`Buying btc`)
        return decision
      } else if (signal.type === TradingMode.sell && lastAction != 'sell' && +tradeTimeDifference.timeInMinutes >= 30) {
        console.log(`Selling: `, bal.sbtc.formatedAssetString())
        const decision = sbusd.assetAmount.amount().toNumber() > tradingAmount + 2 ? TradingMode.sell : TradingMode.hold
        if (decision == TradingMode.sell) this.signalTracker.push(`Selling btc`)
        return decision
      } else {
        if (hasTxRecords) {
          console.log('Last tx record:', this.txRecords[this.txRecords.length - 1])
        }
        console.log(`BTC balance in Busd:`, sbusd.assetAmount.amount().toNumber())
        return TradingMode.hold
      }
    } catch (error) {
      console.log(error)
    }
  }

  private async signal(chart: number[], interval: number): Promise<Signal> {
    let tradeSignal: Signal = {
      type: TradingMode.hold,
      macd: false,
      rsi: false,
      histogram: false,
      decision: '',
    }

    const macd = await this.tradingIndicators.getMacd(chart)
    // period being passed in is 3 hours
    tradeSignal.histogram = macd.histogram[macd.histogram.length - 1] > 0 ? true : false

    const sma = await this.tradingIndicators.getSma(chart, interval)
    const ema = await this.tradingIndicators.getEma(chart, interval)
    const highLowPastFifteenMinutes = await this.tradingIndicators.findHighAndLowValues(
      this.oneMinuteChart.slice(-1080),
      15,
    )
    const highLowPastThreeHours = await this.tradingIndicators.findHighAndLowValues(
      this.oneMinuteChart.slice(-180),
      180,
    )
    console.log(`Past three hours \nHigh ${highLowPastThreeHours.high} \nLow ${highLowPastThreeHours.low}`)
    const psar = await this.tradingIndicators.getParabolicSar(
      highLowPastFifteenMinutes.high,
      highLowPastFifteenMinutes.low,
      this.fifteenMinuteChart.slice(-72),
    )

    const lastTrade = this.txRecords[this.txRecords.length - 1]
    const lastAction = this.txRecords[this.txRecords.length - 1].action
    const lastTradePrice = this.txRecords[this.txRecords.length - 1].assetPrice

    // Check percentage gained
    const percentageGained = this.percentageChangeFromTrade(lastAction, lastTradePrice)
    console.log(`Percentage changed since ${this.txRecords.slice(-1)[0].action}, ${percentageGained.percentageChange}`)

    console.log(`last trade ${lastAction}, ${lastTradePrice}`)
    // analyse ema sma and psar & mcad
    const tradeDecision = this.tradingIndicators.analyzeTradingSignals(
      psar.psar,
      sma,
      ema,
      macd.macdLine,
      macd.signalLine,
      2,
      chart,
      this.fiveMinuteChart,
      psar.trends,
      this.oneMinuteChart,
      lastTrade,
    )
    tradeSignal.decision = tradeDecision.tradeSignal
    tradeSignal.type = tradeDecision.tradeType
    return tradeSignal
  }

  private percentageChangeFromTrade(
    lastTradeAction: string,
    lastTradePrice: number,
  ): { percentageChange: number; direction: string } {
    if (this.txRecords.length === 0) {
      throw new Error('No buy orders available')
    }

    const assetPrice = +this.oneMinuteChart.slice(-1)[0]
    if (isNaN(assetPrice)) {
      throw new Error('Invalid asset price')
    }

    const percentageChange = (assetPrice - lastTradePrice) / lastTradePrice
    let direction = ''

    if (lastTradeAction === 'buy') {
      direction = percentageChange >= 0 ? 'positive' : 'negative'
    } else if (lastTradeAction === 'sell') {
      direction = percentageChange <= 0 ? 'positive' : 'negative'
    } else {
      throw new Error('Invalid last trade action')
    }

    return { percentageChange, direction }
  }

  // ---------------------------- file sync ---------------------------------
  /**
   *
   * @param chart
   * @param interval
   */
  private async writeToFile(chart: number[], interval: string) {
    fs.writeFileSync(`./priceData/${interval}${this.asset.ticker}Data.json`, JSON.stringify(chart, null, 4), 'utf8')
  }

  private async writeTXToFile(transaction: TxDetail) {
    fs.writeFileSync(
      `./${transaction.action}${transaction.asset.ticker}txRecords.json`,
      JSON.stringify(transaction, null, 4),
      'utf8',
    )
  }
  private async writeSignalToFile(signal: string[]) {
    const currentTime = new Date()
    fs.writeFileSync(`./signal/${currentTime.getDate()}Signal.json`, JSON.stringify(signal, null, 4), 'utf8')
  }

  /**
   *
   * @param chartInterval - input
   */
  private async readFromFile(interval: ChartInterval) {
    const result: number[] = JSON.parse(fs.readFileSync(`./priceData/${interval}BTCData.json`, 'utf8'))
    const chopped = result.slice(-1080)

    for (let i = 0; i < chopped.length; i++) {
      let resp = chopped[i]
      if (resp != null) {
        this.oneMinuteChart.push(resp)
      }
    }
  }

  // Read previous trades
  private async readLastSellTrade() {
    const result: TxDetail = JSON.parse(fs.readFileSync(`sellBTCtxRecords.json`, 'utf8'))
    // make sure its a unique trade
    if (this.sellOrders.slice(-1)[0] != result) {
      this.sellOrders.push(result)
    }
  }
  private async readLastBuyTrade() {
    const result: TxDetail = JSON.parse(fs.readFileSync(`buyBUSDtxRecords.json`, 'utf8'))
    // make sure its a unique trade
    if (this.buyOrders.slice(-1)[0] != result) {
      this.buyOrders.push(result)
    }
  }
  // -------------------------------- Wallet actions ------------------------------------

  /**
   *
   * @param password  for the wallet
   * @returns - trading wallet
   */
  private async openWallet(password: string): Promise<TradingWallet> {
    const keystore1 = JSON.parse(fs.readFileSync(this.keystore1FilePath, 'utf8'))
    const seed = await decryptFromKeystore(keystore1, password)

    this.wallet = new Wallet(getClients(seed))
    const tradingWallet: TradingWallet = {
      wallet: this.wallet,
      thorchainAmm: this.thorchainAmm,
    }
    return tradingWallet
  }

  /**
   *
   * @param tradingWallet
   */
  private async sell(tradingWallet: TradingWallet) {
    const pools = await this.thorchainCache.thornode.getPools()
    const busdSynthPaused = pools.find((pool) => pool.asset === `${assetsBUSD.chain}.${assetsBUSD.symbol}`)
    const bal = await this.getSynthBalance()

    const sbusd = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD)
    const sellAmount = sbusd.assetAmount.amount().toNumber() - 1
    const busdMinusOne = new CryptoAmount(assetToBase(assetAmount(sellAmount)), assetsBUSD)
    const sythBTC = await this.thorchainQuery.convert(busdMinusOne, bal.sbtc.asset) // leave a dollar in here so bal is not null
    // is busd mint available
    if (!busdSynthPaused.synth_mint_paused) {
      const fromAsset = bal.sbtc.asset
      // sell the balance
      const destinationAsset = assetsBUSD
      const swapDetail: SwapDetail = {
        amount: sythBTC,
        decimals: 8,
        fromAsset,
        destinationAsset,
      }
      const txHash = await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)
      console.log(txHash)
      let txRecord: TxDetail = {
        date: new Date(),
        action: TradingMode.sell,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length - 1],
        result: txHash,
        rsi: this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1],
      }
      if (txHash) this.sellOrders.push(txRecord)
      if (txHash) this.txRecords.push(txRecord)
      await delay(12 * 1000)
      await this.writeTXToFile(txRecord)
    } else {
      this.signalTracker.push(`Balance BTC synth: ${bal.sbtc.assetAmount.amount().toNumber()}`)
    }
  }

  private async buy(tradingWallet: TradingWallet) {
    const pools = await this.thorchainCache.thornode.getPools()
    const btcSynthPaused = pools.find((pool) => pool.asset === `${assetsBTC.chain}.${assetsBTC.symbol}`)

    const sbusd = new CryptoAmount(assetToBase(assetAmount(tradingAmount)), assetsBUSD)
    const fromAsset = assetsBUSD
    const destinationAsset = assetsBTC
    const swapDetail: SwapDetail = {
      amount: sbusd,
      decimals: 8,
      fromAsset,
      destinationAsset,
    }
    if (!btcSynthPaused.synth_mint_paused) {
      const txHash = await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)
      console.log(txHash)
      let txRecord: TxDetail = {
        date: new Date(),
        action: TradingMode.buy,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length - 1],
        result: txHash,
        rsi: this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1],
      }
      if (txHash) this.buyOrders.push(txRecord)
      if (txHash) this.txRecords.push(txRecord)
      await delay(12 * 1000)
      await this.writeTXToFile(txRecord)
    } else {
      this.signalTracker.push('BTC synth trading is paused')
    }
  }
  /**
   *
   * @param botStartTime - the time the bot went live
   * @returns - Time difference between current time and bot to live
   */
  public async timeCorrection(botStartTime: Date): Promise<Time> {
    const difference = await this.getTimeDifference(botStartTime)
    return difference
  }
  /**
   *
   * @returns - Synth balance for the wallet
   */
  private async getSynthBalance(): Promise<SynthBalance> {
    let synthbtc = assetsBTC
    let synthBUSD = assetsBUSD
    let synthBTCB = assetsBTCB

    try {
      const address = this.wallet.getAddress(THORChain)
      const balance = await this.wallet.clients[THORChain].getBalance(address)
      const bitcoinBal = balance.find((asset) => asset.asset.ticker === synthbtc.ticker)
        ? balance.find((asset) => asset.asset.ticker === synthbtc.ticker).amount
        : null
      const busdBal = balance.find((asset) => asset.asset.ticker === synthBUSD.ticker)
        ? balance.find((asset) => asset.asset.ticker === synthBUSD.ticker).amount
        : null
      const btcbBal = balance.find((asset) => asset.asset.ticker === synthBTCB.ticker)
        ? balance.find((asset) => asset.asset.ticker === synthBTCB.ticker).amount
        : null

      const sbalance: SynthBalance = {
        sbusd: new CryptoAmount(busdBal, assetsBUSD),
        sbtc: new CryptoAmount(bitcoinBal, assetsBTC),
        sbtcb: btcbBal !== null ? new CryptoAmount(btcbBal, assetsBTCB) : new CryptoAmount(baseAmount(0), assetsBTCB),
      }
      return sbalance
    } catch (error) {
      console.log(`Error fetching bal: `, error)
    }
  }

  private async isTradingHalted(): Promise<boolean> {
    const checkMimr = await this.thorchainCache.thornode.getMimir()
    const isTradinghalted = checkMimr['HALTTHORCHAIN']
    if (Number(isTradinghalted) === 0) {
      return false
    } else {
      return true
    }
  }

  private schedule(): void {
    console.log('Starting scheduled task...')
    this.intervalId = setInterval(async () => {
      const currentTime = new Date()
      if (currentTime >= this.botConfig.startTime) {
        await this.displayData()
      }
    }, this.interval)
  }

  private async displayData() {
    const timeAlive = await this.getTimeDifference(this.botConfig.startTime)
    try {
      const bal = await this.getSynthBalance()
      console.log(bal.sbtc.formatedAssetString())
      console.log(bal.sbusd.formatedAssetString())
      const sbusdworthofbtc = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD)
      const sbusdworthofbtcb = await this.thorchainQuery.convert(bal.sbtcb, assetsBUSD)
      console.log(`Btc in Busd: ${sbusdworthofbtc.formatedAssetString()}`)
      console.log(`BtcB in Busd: ${sbusdworthofbtcb.formatedAssetString()}`)
    } catch (err) {
      console.log(`Can't fetch balances`)
    }

    console.log(`Buy records: `, this.buyOrders.length)
    console.log(`Sell records: `, this.sellOrders.length)
    console.log(
      `Time alive: `,
      Number(timeAlive.timeInMinutes) > 1080 ? timeAlive.timeInHours : timeAlive.timeInMinutes,
    )
    if (Number(timeAlive.timeInHours) % 2 && this.signalTracker.length > 1) {
      await this.writeSignalToFile(this.signalTracker)
    }
    console.log(`Minute Chart length: `, this.oneMinuteChart.length)
    console.log(`Buy orders: `, this.buyOrders.length)
    console.log(`Sell orders: `, this.sellOrders.length)
    console.log(`Signals : `, this.signalTracker.slice(-10))
  }
}
