import * as fs from 'fs'

import { ThorchainAMM, Wallet } from "@xchainjs/xchain-thorchain-amm"
import { CryptoAmount, Midgard, ThorchainCache, ThorchainQuery, Thornode } from "@xchainjs/xchain-thorchain-query"
import { decryptFromKeystore } from '@xchainjs/xchain-crypto'
import { Network } from "@xchainjs/xchain-client"
import { Client, getBalance, THORChain, ThorchainClient } from '@xchainjs/xchain-thorchain'
import { assetAmount, assetFromStringEx, delay, assetToBase, Asset, baseToAsset, baseAmount} from '@xchainjs/xchain-util'
import { doSingleSwap } from './doSwap'
import { Action, BotInfo, BotMode, ChartInterval, HighAndLow, Signal, SwapDetail, SynthBalance, Time, TradingMode, TradingWallet, TxDetail } from './types'

import { BollingerBands, ema, macd, MacdResult, rsi } from 'indicatorts'

require('dotenv').config();

const assetBUSD = assetFromStringEx(`BNB.BUSD-BD1`)
const assetsBUSD = assetFromStringEx(`BNB/BUSD-BD1`)
const assetsBTC = assetFromStringEx(`BTC/BTC`)

const oneMinuteInMs = 60 * 1000  // 1 minute in milliseconds

 
export class AlphaBot {
  //private pools: Record<string, LiquidityPool> | undefined
  private thorchainCache: ThorchainCache
  private thorchainQuery: ThorchainQuery

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


  constructor(
      network: Network,
      keystore1FilePath: string,
      keystore1Password: string,
      pauseTimeSeconds: number,
  ) {
      this.keystore1FilePath = keystore1FilePath
      this.keystore1Password = keystore1Password
      this.pauseTimeSeconds = pauseTimeSeconds
      this.thorchainCache = new ThorchainCache(new Midgard(network), new Thornode(network))
      this.thorchainQuery = new ThorchainQuery(this.thorchainCache)
      this.thorchainAmm = new ThorchainAMM(this.thorchainQuery)
      this.interval = 10 * 60 * 1000; // 10 minutes in milliseconds
  }


  private async walletSetup() {
    const keystore = JSON.parse(fs.readFileSync(this.keystore1FilePath, 'utf8'))
    const phrase1 = await decryptFromKeystore(keystore, this.keystore1Password)

    this.wallet = new Wallet(phrase1, this.thorchainQuery)
  }




  async start(interval:ChartInterval) {
      console.log(`Start time: ${this.botConfig.startTime}`)
      console.log('Setting up wallet')
      await this.walletSetup()
      console.log('Running AlphaBot....')
      const bal = await this.getSynthBalance()
      console.log(bal.sbtc.formatedAssetString())
      console.log(bal.sbusd.formatedAssetString())
      this.schedule()
      while (this.botConfig.botMode !== BotMode.stop) { 
        let action: TradingMode
        const tradingHalted = await this.isTradingHalted()
        if(tradingHalted) {
          action = this.botConfig.tradingMode
        } else {
          action = await this.injestTradingData(interval)
          console.log(action)
          if(action === TradingMode.buy || action === TradingMode.sell) {
            await this.writeSignalToFile(this.signalTracker)
            await this.writeToFile(this.oneMinuteChart.slice(-10), action)         
          }
        }
        await this.executeAction(action)  
      }
      if(this.oneMinuteChart.length > 1080) {
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
      default:
        break
    }
  }
  private async injestTradingData(interval: string): Promise<TradingMode> {
    let market: TradingMode
    const macd = await this.getMacd(this.fifteenMinuteChart)
    await this.getRsi(this.fifteenMinuteChart)
    const rsiHighLow = await this.findHighAndLowValues(this.rsi.slice(-12))
    console.log(`Collecting trading signals for ${interval}`)
    console.log(`Rsi: ${this.rsi[this.rsi.length -1]}`)
    console.log(`Rsi last 3 hours, High ${rsiHighLow.high} and lows: ${rsiHighLow.low}`)
    let sellSignal: Signal
    let buySignal: Signal

    console.log(`Last Price: ${this.asset.chain} $`, this.oneMinuteChart[this.oneMinuteChart.length -1])
    if (this.fiveMinuteChart.length -1 < 72 ) {
      const percentageComplete = this.fiveMinuteChart.length -1 / 72 * 100
      console.log(`Alphabot is waiting for data maturity: ${percentageComplete.toFixed()} % complete `)
      return TradingMode.hold
    } else {
      if (this.rsi[this.rsi.length - 1] > 65) {
        sellSignal = await this.sellSignal(macd)
        console.log(`Sell > macd: ${sellSignal.macd}, rsi: ${sellSignal.rsi}`)
        market = await this.checkMarketType(sellSignal)
      } else if (this.rsi[this.rsi.length - 1] < 45 ){
        buySignal = await this.buySignal(macd)
        console.log(`Buy > macd: ${buySignal.macd}, rsi: ${buySignal.rsi}`)
        market = await this.checkMarketType(buySignal)
      } else {
        market = TradingMode.hold
      }

      return market
    }
  }

  public async dataCollectionMinute(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC
    console.log(`Collecting ${this.asset.ticker} pool price`)
    await this.readFromFile(interval)
    const highlow = await this.findHighAndLowValues(this.oneMinuteChart)
    console.log(`One minute chart highs and lows`, highlow)

    while(start) { 
        // One minute
        await this.getAssetPrice(interval)
        await this.writeToFile(this.oneMinuteChart,  interval)
        await delay(oneMinuteInMs)
        if(this.oneMinuteChart.length > 1080) {
          await this.readFromFile(ChartInterval.OneMinute)
        }

    }
  }
  public async dataCollectionFiveMinutes(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter((value, index) => (index + 1) % 5 === 0)
      if(this.fiveMinuteChart.length < 1) {
        this.fiveMinuteChart.push(...filtered)
      } else {
        const lastEntryFive = this.fiveMinuteChart[this.fiveMinuteChart.length -1]
        const lastFilterd = filtered[filtered.length -1]
        if(lastFilterd !== lastEntryFive) {
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
      if(this.fifteenMinuteChart.length < 1) {
        this.fifteenMinuteChart.push(...filtered)
      } else {
        const lastEntryFive = this.fifteenMinuteChart[this.fifteenMinuteChart.length -1]
        const lastFilterd = filtered[filtered.length -1]
        if(lastFilterd !== lastEntryFive) {
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
      if(this.halfHourChart.length < 1) {
        this.halfHourChart.push(...filtered)
      } else {
        const lastEntryFive = this.halfHourChart[this.halfHourChart.length -1]
        const lastFilterd = filtered[filtered.length -1]
        if(lastFilterd !== lastEntryFive) {
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
      if(this.OneHourChart.length < 1) {
        this.OneHourChart.push(...filtered)
      } else {
        const lastEntryFive = this.OneHourChart[this.OneHourChart.length -1]
        const lastFilterd = filtered[filtered.length -1]
        if(lastFilterd !== lastEntryFive) {
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

private async getTimeDifference(startTime: Date ): Promise<Time> {
  const currentTime = new Date()
  const difference = currentTime.getTime() - startTime.getTime()
  const time: Time = {
      timeInSeconds: difference / 1000,
      timeInMinutes: difference / 1000 / 60,
      timeInHours: difference / 1000 / 60 /60,
  }
  return time
}

private async checkMarketType(signal: Signal): Promise<TradingMode> {
  const hasTxRecords = this.txRecords.length > 0
  
  const bal = await this.getSynthBalance() // need to work on this
  if(signal.type === TradingMode.buy && bal.sbusd.assetAmount.amount().toNumber() >= 400){
    return TradingMode.buy
  } else if (signal.type === TradingMode.sell && bal.sbtc.assetAmount.amount().toNumber() >= 0.01451937) {
    return TradingMode.sell
  } else {
    console.log(`Has tx records:`, hasTxRecords)
    if(hasTxRecords)
      console.log(`Last tx record: `, this.txRecords[this.txRecords.length -1])
    return TradingMode.hold
  }
}
/**
 * 
 * @param values array of price data 
 * @param period what period to calculate by 
 * @returns 
 */
public async getEma(values: number[], period: number): Promise<number[]> {
    const result = ema(period, values)
    return result
}
/**
 * 
 * @param closings 
 */
public async getRsi(closings: number[]) {
  if (closings.length < 14) {
    throw new Error('Cannot calculate RSI with less than 14 closing prices.')
  }

  const result = rsi(closings)
  const filteredResult = result.filter((value) => value !== 100 && value !== 0)
  for (let i = 0; i < filteredResult.length; i++) {
    const rsiEntry = +filteredResult[i].toFixed(4)
    if (this.rsi.indexOf(rsiEntry) === -1) {
      this.rsi.push(rsiEntry)
    }
  }
  await this.writeToFile(this.rsi, 'rsi')
  await this.writeToFile(filteredResult, 'rsiRaw')
}
public async getMacd(closings: number[]): Promise<MacdResult> {
    const result = macd(closings)
    return result
}
/**
 * 
 * @param period 
 * @param rsiLowerThreshold 
 * @returns 
 */
private async isRSIBuySignal(period: number, rsiLowerThreshold: number): Promise<boolean> {
  const currentRSI = this.rsi[this.rsi.length - 1];

  if (currentRSI >= rsiLowerThreshold) {
    return false;
  }

  const startIndex = Math.max(this.rsi.length - period, 1);
  if (startIndex === 1 && this.rsi[0] >= rsiLowerThreshold) {
    return false;
  }

  for (let i = startIndex; i < this.rsi.length; i++) {
    const currentRSIInLoop = this.rsi[i];
    const previousRSIInLoop = this.rsi[i - 1];

    if (previousRSIInLoop < rsiLowerThreshold && currentRSIInLoop >= rsiLowerThreshold) {
      console.log("RSI dipped below threshold and is rebounding");
      this.signalTracker.push("RSI dipped below threshold and is rebounding");
      return true; // Buy signal confirmed
    }
  }

  return false; // No buy signal detected
}
/**
 * 
 * @param period 
 * @param rsiUpperThreshold 
 * @returns 
 */
private async isRSISellSignal(period: number, rsiUpperThreshold: number): Promise<boolean> {
  const currentRSI = this.rsi[this.rsi.length - 1];

  if (currentRSI <= rsiUpperThreshold) {
    return false;
  }

  const startIndex = Math.max(this.rsi.length - period, 1);
  if (startIndex === 1 && this.rsi[0] <= rsiUpperThreshold) {
    return false;
  }

  for (let i = startIndex; i < this.rsi.length; i++) {
    const currentRSIInLoop = this.rsi[i];
    const previousRSIInLoop = this.rsi[i - 1];
    if (previousRSIInLoop > rsiUpperThreshold && currentRSIInLoop <= rsiUpperThreshold) {
      console.log("Rsi is above sell threshold and is returning");
      this.signalTracker.push(`${previousRSIInLoop}`)
      this.signalTracker.push(`${rsiUpperThreshold}`)
      this.signalTracker.push(`${currentRSIInLoop}`)
      return true // Sell signal confirmed
    }
    
  }

  return false; // No sell signal detected
}
private async buySignal(macdResult: MacdResult): Promise<Signal> {
    let macdSignal: Boolean
    let rsiSignal: Boolean
    let signalType = TradingMode.buy
    const rsiLowerThreshold = 22
    const currentPeriod = macdResult.macdLine.length - 1
    const previousPeriod = currentPeriod - 1
    if (macdResult.macdLine[currentPeriod] < macdResult.signalLine[currentPeriod] && macdResult.macdLine[previousPeriod] > macdResult.signalLine[previousPeriod]) {
    // MACD line just crossed below the signal line, generate a buy signal
      console.log(`Macd just crossed below the signal`)
      macdSignal = true
    }else {
      console.log(`Current macd period: ${macdResult.macdLine[currentPeriod]}` )
      console.log(`Current signal period: ${macdResult.signalLine[currentPeriod]}`)
      macdSignal = false
    }
    const rsiData = await this.valueDirection(this.rsi, 14, 'rsi')
    const priceDirection = await this.valueDirection(this.oneMinuteChart, 10, 'price')
    console.log(`Rsi direction ${rsiData}`)
    console.log(`Price direction ${rsiData}`)
    rsiSignal = await this.isRSIBuySignal(1, rsiLowerThreshold)
    if(macdSignal && rsiSignal) { 
      this.signalTracker.push(`${this.rsi.slice(-1)}, ${currentPeriod}, ${this.oneMinuteChart.slice(-1)}, ${signalType}, ${priceDirection}`)
    }
    if(this.rsi[this.rsi.length -1] < 20) {
      this.signalTracker.push(`${this.rsi.slice(-1)}, ${currentPeriod}, ${this.oneMinuteChart.slice(-1)}, ${signalType}, ${priceDirection}`)
      const buysignal: Signal = {
        type: signalType,
        macd: true,
        rsi: true,
      }
      return buysignal
    }
    const signal: Signal = {
      type: signalType,
      macd: macdSignal,
      rsi: rsiSignal,
    }
    return signal
}
private async sellSignal(macdResult: MacdResult): Promise<Signal> {
  let macdSignal: Boolean
  let rsiSignal: Boolean
  let signalType = TradingMode.sell
  const rsiUpperThreshold = 76
  const lastMacd = macdResult.macdLine[macdResult.macdLine.length - 1]
  const secondLastMacd = macdResult.macdLine[macdResult.macdLine.length - 2]
  const lastSignal = macdResult.signalLine[macdResult.signalLine.length - 1]
  const secondLastSignal = macdResult.signalLine[macdResult.signalLine.length - 2]

  if (secondLastSignal > secondLastMacd && lastSignal <= lastMacd) {
    // MACD line just crossed above the signal line, generate a sell signal
    console.log("Macd just crossed above the signal")  
    macdSignal = true
  } else {
    console.log(`Current period macd: ${lastMacd}`)
    console.log(`Current period signal: ${lastSignal}`)
    macdSignal = false
  }

  const rsiData = await this.valueDirection(this.rsi, 4, 'rsi')
  rsiSignal = await this.isRSISellSignal(1, rsiUpperThreshold)
  const priceDirection = await this.valueDirection(this.oneMinuteChart, 10, 'price')
  console.log(`Rsi direction ${rsiData}`)
  console.log(`Price direction ${rsiData}`)


  if(macdSignal && rsiSignal) {
    this.signalTracker.push(`${this.rsi.slice(-1)}, ${lastMacd}, ${this.oneMinuteChart.slice(-1)}, ${signalType}, ${priceDirection}`)
  }
  if(this.rsi[this.rsi.length -1] > 85) {
    this.signalTracker.push(`${this.rsi.slice(-1)}, ${lastMacd}, ${this.oneMinuteChart.slice(-1)}, ${signalType}, ${priceDirection}`)
    const sellSignal: Signal = {
      type: signalType,
      macd: true,
      rsi: true,
    }
    return sellSignal
  }
  const signal: Signal = {
    type: signalType,
    macd: macdSignal,
    rsi: rsiSignal,
  }

  return signal
}


  private async openWallet (password: string): Promise<TradingWallet> {
      const keystore1 = JSON.parse(fs.readFileSync(this.keystore1FilePath, 'utf8'))
      const seed = await decryptFromKeystore(keystore1, password)
      const thorchainCache = new ThorchainCache(new Midgard(), new Thornode())
      const thorchainQuery = new ThorchainQuery(thorchainCache)
      this.wallet = new Wallet(seed, thorchainQuery)
      const tradingWallet: TradingWallet = {
        wallet: this.wallet,
        thorchainAmm: this.thorchainAmm,
      }
      return tradingWallet
  }
  

    /**
     * 
     * @param chart 
     * @param interval 
     */
    private async writeToFile(chart: number[], interval: string) {
      fs.writeFileSync(`./priceData/${interval}${this.asset.ticker}Data.json`, JSON.stringify(chart, null, 4), 'utf8')
    }

    private async writeTXToFile(transaction: TxDetail) { 
      fs.writeFileSync(`./${transaction.action}${transaction.asset.ticker}txRecords.json`, JSON.stringify(transaction, null, 4), 'utf8')
    }
    private async writeSignalToFile(signal: string[]) { 
      const currentTime = new Date()
      fs.writeFileSync(`./signal/${currentTime.getDate()}Signal.json`, JSON.stringify(signal, null, 4), 'utf8')
    }

      
    /**
     * 
     * @param chartInterval - input
     */
    private async readFromFile(interval: ChartInterval){
      const result: number[] = JSON.parse(fs.readFileSync(`./priceData/${interval}BTCData.json`, 'utf8'))
      const chopped = result.slice(-720)
      
      for (let i = 0; i < chopped.length; i++) {
        let resp = chopped[i]
        if (resp != null) {
          this.oneMinuteChart.push(resp)
        }
      }
    }
    /** Helper function to find highs and lows in an array
     * 
     * @param data - input array
     * @returns 
     */
   private async findHighAndLowValues(data: number[]): Promise<HighAndLow>{
      let high: number = Number.MIN_SAFE_INTEGER
      let low: number = Number.MAX_SAFE_INTEGER
      for (let i = 0; i < data.length; i++) {
        const value: number = data[i]
        if (value > high) {
          high = value
        }
        if (value < low) {
          low = value
        }
      }
      return { high, low }
    }

    /**
     * 
     * @param values 
     * @returns - direction of values based on period
     */
    private async valueDirection(values: number[], period: number, name: string): Promise<string>{
      let sumRateOfChange = 0
      let sortArray = values.slice(-period)
      for (let i = 1; i < sortArray.length; i++) {
        const rateOfChange = (sortArray[i] - sortArray[i - 1]) / sortArray[i - 1]
        sumRateOfChange += rateOfChange
      }
      const averageRateOfChange = sumRateOfChange / (sortArray.length - 1)
      const roundedAverageRateOfChange = Math.round(averageRateOfChange * 100) / 100;
      console.log(`Average rate of ${name} change: ${roundedAverageRateOfChange}`);
      if (averageRateOfChange < 0) {
        return "Negative";
      } else if (averageRateOfChange > 0) {
        return "Positive";
      } else {
        return "No Change";
      }
    }
    // -------------------------------- Wallet actions ------------------------------------ 
    /**
     * 
     * @param tradingWallet 
     */
    private async sell(tradingWallet: TradingWallet){
      const amount = new CryptoAmount(assetToBase(assetAmount(400, 8)), assetBUSD)
      const sBTC = await this.thorchainQuery.convert(amount, assetsBTC)
      
      const address = 'thor1nx3yxgdw94nfw0uzwns2ay5ap85nk9p6hjaqn9'
      const fromAsset = assetsBTC
      const destinationAsset = assetsBUSD
      const swapDetail: SwapDetail = {
        amount: sBTC,
        decimals: 8,
        fromAsset,
        destinationAsset,
        desstinationAddress: address,  
      }
      const txHash = await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)
      console.log(txHash)
      let txRecord: TxDetail =  {
        date: new Date(),
        action: TradingMode.sell,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length -1],
        result: txHash,
        rsi: this.rsi[this.rsi.length -1]
      }
      this.sellOrders.push(txRecord)
      this.txRecords.push(txRecord)
      await delay(12 * 1000)
      await this.writeTXToFile(txRecord)
    }
  
    private async buy(tradingWallet: TradingWallet){
      const amountBUSD = new CryptoAmount(assetToBase(assetAmount(400, 8)), assetsBUSD)
      const address = 'thor1nx3yxgdw94nfw0uzwns2ay5ap85nk9p6hjaqn9'
      const fromAsset = assetsBUSD
      const destinationAsset = assetsBTC
      const swapDetail: SwapDetail = {
        amount: amountBUSD,
        decimals: 8,
        fromAsset,
        destinationAsset,
        desstinationAddress: address,  
      }
      const txHash = await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)
      console.log(txHash)
      let txRecord: TxDetail =  {
        date: new Date(),
        action: TradingMode.buy,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length -1],
        result: txHash,
        rsi: this.rsi[this.rsi.length -1]
      }
      this.buyOrders.push(txRecord)
      this.txRecords.push(txRecord)
      await delay(12 * 1000)
      await this.writeTXToFile(txRecord)
    }
    /**
     * 
     * @param botStartTime - the time the bot went live
     * @returns - Time difference between current time and bot to live 
     */
    public async timeCorrection(botStartTime: Date): Promise<Time>{
      const difference = await this.getTimeDifference(botStartTime)
      return difference
    }
    /**
     * 
     * @returns - Synth balance for the wallet
     */
    private async getSynthBalance(): Promise<SynthBalance>{
      let synthbtc = assetsBTC
      let synthBUSD = assetsBUSD
      const address = this.wallet.clients[THORChain].getAddress()
      const balance = this.wallet.clients[THORChain].getBalance(address)
      const bitcoin = (await balance).find((asset) => asset.asset.ticker === synthbtc.ticker).amount
      const busd = (await balance).find((asset) => asset.asset.ticker === synthBUSD.ticker).amount
      const sbalance: SynthBalance = {
        sbtc: new CryptoAmount(bitcoin, assetsBTC),
        sbusd: new CryptoAmount(busd, assetsBUSD)
      }
      return sbalance
    }

    private async isTradingHalted(): Promise<boolean> {
      const checkMimr = await this.thorchainCache.thornode.getMimir()
      const isTradinghalted = checkMimr['HALTTHORCHAIN']
      if(Number(isTradinghalted) === 0) {
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
      const bal = await this.getSynthBalance()
      console.log(bal.sbtc.formatedAssetString())
      console.log(bal.sbusd.formatedAssetString())
      console.log(`TxRecords: `, this.txRecords.length )
      console.log(`Time alive: `, (await this.getTimeDifference(this.botConfig.startTime)).timeInMinutes)
      console.log(`Minute Chart length: `, this.oneMinuteChart.length)
      console.log(`Buy orders: `, this.buyOrders.length)
      console.log(`Sell orders: `, this.sellOrders.length)
    }
}