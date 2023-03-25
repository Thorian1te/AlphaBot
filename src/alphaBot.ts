import * as fs from 'fs'

import { ThorchainAMM, Wallet } from "@xchainjs/xchain-thorchain-amm"
import { CryptoAmount, Midgard, ThorchainCache, ThorchainQuery, Thornode } from "@xchainjs/xchain-thorchain-query"
import { decryptFromKeystore } from '@xchainjs/xchain-crypto'
import { doSingleSwap } from './doSwap'
import { BotInfo, BotMode, ChartInterval, HighAndLow, Signal, SwapDetail, Time, TradingWallet, TxDetail } from './types'
import { Network } from "@xchainjs/xchain-client"
import { assetAmount, assetFromStringEx, delay, assetToBase, Asset} from '@xchainjs/xchain-util'
import { AssetRuneNative } from '@xchainjs/xchain-thorchain'
import { ema, macd, MacdResult, rsi } from 'indicatorts'
import price from '../priceData/1mBTCData.json'

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
  public halfHourChart: number[] = []
  public OneHourChart: number[] = []
  public rsi: number[] = []

  private thorchainAmm: ThorchainAMM
  private keystore1FilePath: string
  private keystore1Password: string
  private wallet: Wallet | undefined
  private pauseTimeSeconds: number
  private asset: Asset
  private botConfig: BotInfo


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

  }


  private async walletSetup() {
    const keystore = JSON.parse(fs.readFileSync(this.keystore1FilePath, 'utf8'))
    const phrase1 = await decryptFromKeystore(keystore, this.keystore1Password)

    this.wallet = new Wallet(phrase1, this.thorchainQuery)
  }



  async start() {
      console.log('Setting up wallet')
      await this.walletSetup()
      console.log('Running AlphaBot....')
      let info = await this.getAlphaBotInfo()
      while (info.botMode !== BotMode.stop) { // need to figure out a way to start and stop this. 
        // select a random action

        const action = await this.marketType()
        console.log(action)
        if(action === 'buy' || action === 'sell') {
          await this.writeToFile(this.oneMinuteChart.slice(-10), action)
        }
        await this.executeAction(action)
      }
    }

  private async executeAction(action: string) {
    const tradingWallet = await this.openWallet(this.keystore1Password)
    switch (action) {
      case 'buy':
        await this.buy(tradingWallet)
        break
      case 'sell':
        await this.sell(tradingWallet)
        break
      case 'idle':
        await delay(this.pauseTimeSeconds * 999)
        break
      default:
        break
    }
  }
  private async marketType(): Promise<string> {

    const macd = await this.getMacd(this.fiveMinuteChart)
    await this.getRsi(this.fiveMinuteChart)
    const buySignal = await this.buySignal(macd, this.rsi)
    const sellSignal = await this.sellSignal(macd, this.rsi)
    const rsiHighLow = await this.findHighAndLowValues(this.rsi)
    console.log(`Signal to buy: macd: ${buySignal.macd}, rsi: ${buySignal.rsi}`)
    console.log(`Signal to sell: macd: ${sellSignal.macd}, rsi: ${sellSignal.rsi}`)
    console.log(`Rsi: ${this.rsi[this.rsi.length -1]}, High ${rsiHighLow.high} and lows: ${rsiHighLow.low}`)
    console.log(`Last Price: ${this.asset.chain} $${this.oneMinuteChart[this.oneMinuteChart.length -1]}`)
    if (this.fiveMinuteChart.length -1 < 70) {
      const percentageComplete = this.fiveMinuteChart.length -1 / 72 * 100
      console.log(`Alphabot is waiting for data maturity % ${percentageComplete.toFixed()} `)
      return 'idle'
    } else {
      const market = await this.checkMarketType(buySignal, sellSignal)
      return market
    }
  }

  private async getAlphaBotInfo(): Promise<BotInfo> {

    const stored: BotInfo = JSON.parse(fs.readFileSync(`./botConfig.json`, 'utf8')) as BotInfo
    if (stored) {
      console.log(stored)
      return stored
    }
    const startTime = new Date()
    const botInfo: BotInfo = {
      botMode: BotMode.runIdle,
      walletStatus: `initialized`,
      dataCollection: true,
      startTime
    }
    await this.botConfigWrite(botInfo)
    return botInfo
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

    }
  }
  public async dataCollectionFiveMinutes(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC
    console.log(`Collecting ${this.asset.ticker} pool price at interval ${interval}`)
    console.log(`Five minute chart: `, this.fiveMinuteChart[this.fiveMinuteChart.length -1])
    while(start) {
        // Extra values from one Minute chart
        for (let i = 0; i < this.oneMinuteChart.length; i++) {
          if ((i + 1) % 5 === 0) {
            await this.intervalSwitch(interval, this.oneMinuteChart[i])
          }
        }

        if(this.fiveMinuteChart.length <= 72) {
          console.log(`here, ${this.fiveMinuteChart.slice(-1)} ${this.fiveMinuteChart.length}`)
          await this.writeToFile(this.fiveMinuteChart, interval)
        } else {
          const lastEntry: number[] = []
          lastEntry.push(this.fiveMinuteChart[this.fiveMinuteChart.length -1])
          await this.writeToFile(lastEntry, interval)
        }
        await delay(oneMinuteInMs * 5)
    }
  }
  public async dataCollectionHalfHour(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC
    console.log(`Collecting ${this.asset.ticker} pool price at interval ${interval}`)
    const highlow = await this.findHighAndLowValues(this.halfHourChart)
    console.log(`Half hour chart, chart highs${highlow.high} and lows:${highlow.low} `)
    while(start) {
        // Thirty minutes
        // Extra values from one Minute chart 
        for (let i = 0; i < this.oneMinuteChart.length; i++) {
          if ((i + 1) % 30 === 0) {
            await this.intervalSwitch(interval, this.oneMinuteChart[i])
          }
        }
        if(this.halfHourChart.length <= 12) {
          await this.writeToFile(this.halfHourChart, interval)
        } else {
          const lastEntry: number[] = []
          lastEntry.push(this.halfHourChart[this.halfHourChart.length -1])
          await this.writeToFile(lastEntry, interval)
        }
        await delay(oneMinuteInMs * 30)
    }
  }
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
    this.intervalSwitch(chartInterval, price)
  } catch (err) {
    console.log(`Error fetching price ${err}`)
  }
}


private async intervalSwitch(interval: string, price: number) {
  switch (interval){
      case '1m':
          this.oneMinuteChart.push(price)
          break
      case `5m`:
          this.fiveMinuteChart.push(price)
          break
      case `30m`:
          this.halfHourChart.push(price)
          break
      case `1hr`:
          this.OneHourChart.push(price)
          break
      default:
          break
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

private async checkMarketType(buySignal: Signal, sellSignal: Signal): Promise<string> {
  const lastTxAction = this.txRecords.length > 0 ? this.txRecords[-1].action : 'idle'
  console.log(this.txRecords[0])
  console.log(lastTxAction)
  if(buySignal.rsi && lastTxAction != 'buy'){
    return 'buy'
  } else if (sellSignal.rsi && lastTxAction != 'sell') {
    return 'sell'
  } else {
    return 'idle'
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
  const result = rsi(closings)
  const filteredResult = result.filter((value) => value !== 100 && value !== 0)

  if(this.rsi.length < 1) {
    for( var i = 0; i < filteredResult.length; i++) {
      this.rsi.push(filteredResult[i])
    }
    await this.writeToFile(this.rsi, 'rsi')
  } else {
    let lastEntry: number [] = []
    lastEntry.push(filteredResult[filteredResult.length -1])
    if(lastEntry[0] != filteredResult[filteredResult.length -1]){
      this.rsi.push(filteredResult[filteredResult.length -1])
      await this.writeToFile(this.rsi, 'rsi')
    }
  }

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
private async isRSIBuySignal( period: number, rsiLowerThreshold: number): Promise<Boolean> {
   // Get the current RSI value
   const currentRSI = this.rsi[this.rsi.length -1]
   const previousRSI = this.rsi[this.rsi.length -2]
  if (currentRSI < rsiLowerThreshold) { // Check if the RSI value falls below the lower threshold
    // Wait for the RSI value to cross back above the lower threshold
    for (let i = period; i < this.fiveMinuteChart.length; i++) {
      if (previousRSI < rsiLowerThreshold && currentRSI >= rsiLowerThreshold) {
        console.log(`Rsi dipped below threshold and is rebounding`)
        return true; // Buy signal confirmed
      }
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
private async isRSISellSignal( period: number, rsiUpperThreshold: number): Promise<Boolean> {
  // Get the current RSI value
  const currentRSI = this.rsi[this.rsi.length -1]
  const previousRSI = this.rsi[this.rsi.length -2]
 if (currentRSI > rsiUpperThreshold) { // Check if the RSI value falls below the lower threshold
   // Wait for the RSI value to cross back above the lower threshold
   for (let i = period; i < this.fiveMinuteChart.length; i++) {
     if (previousRSI > rsiUpperThreshold && currentRSI >= rsiUpperThreshold) {
       console.log(`Rsi is above sell threshold and is returning`)
       return true; // Buy signal confirmed
     }
   }
 }
 return false; // No buy signal detected
}

private async buySignal(macdResult: MacdResult, rsi: number[]): Promise<Signal> {
    let macdSignal: Boolean
    let rsiSignal: Boolean

    const rsiLowerThreshold = 25
    const currentPeriod = macdResult.macdLine.length - 1
    const previousPeriod = currentPeriod - 1
    if (macdResult.macdLine[currentPeriod] < macdResult.signalLine[currentPeriod] && macdResult.macdLine[previousPeriod] > macdResult.signalLine[previousPeriod]) {
    // MACD line just crossed below the signal line, generate a sell signal
      console.log(`Macd just crossed on the signal`)
      macdSignal = true
    }else {
      console.log(`Current macd period: ${macdResult.macdLine[currentPeriod]}` )
      console.log(`Current signal period: ${macdResult.signalLine[currentPeriod]}`)
      macdSignal = false
    }
    const rsiData = await this.valueDirection(rsi, 15)
    rsiSignal = await this.isRSIBuySignal(1, rsiLowerThreshold)
    const signal: Signal ={
      macd: macdSignal,
      rsi: rsiSignal,
    }
    return signal
}
private async sellSignal(macdResult: MacdResult, rsi: number[]): Promise<Signal> {
  let macdSignal: Boolean
  let rsiSignal: Boolean
  const rsiUpperThreshold = 70
    const lastMacd = macdResult.macdLine[macdResult.macdLine.length -1]
    const secondLastMacd = macdResult.macdLine[macdResult.macdLine.length -2]
    const lastSignal = macdResult.signalLine[macdResult.signalLine.length -1]
    const secondLastSignal = macdResult.signalLine[macdResult.signalLine.length -2]
    if (macdResult.signalLine[secondLastSignal] > macdResult.macdLine[secondLastMacd] &&
      macdResult.signalLine[lastSignal] <= macdResult.signalLine[lastMacd]) {
    // MACD line just crossed above the signal line, generate a sell signal
      console.log(`Macd just crossed above the signal`)
      macdSignal = true
    }else {
      console.log(`Current period macd: ${lastMacd}` )
      console.log(`Current period signal: ${lastSignal}`)
      macdSignal = false
    }
    const rsiData = await this.valueDirection(rsi, 15)
    rsiSignal = await this.isRSISellSignal(1, rsiUpperThreshold )
    const signal: Signal ={
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
      fs.writeFileSync(`./${transaction.date}txRecords.json`, JSON.stringify(transaction, null, 4), 'utf8')
    }

      /**
   * 
   * @param chart 
   * @param interval 
   */
    private async botConfigWrite(botInfo: BotInfo) {
      fs.writeFileSync(`./botConfig.json`, JSON.stringify(botInfo, null, 4), 'utf8')
    }
      

    private async readFromFile(chartInterval: string){
      const result: number[] = JSON.parse(fs.readFileSync(`./priceData/${chartInterval}BTCData.json`, 'utf8'))
      const chopped = result.slice(-360)
      for( var i = 0; i < chopped.length; i++){
        let resp = chopped[i]
        if(resp != null) {
          this.intervalSwitch(chartInterval, resp)
        }
      }
    }
    /** Helper function to find highs and lows in an array
     * 
     * @param data - input array
     * @returns 
     */
   private async findHighAndLowValues(data: number[]): Promise<HighAndLow>{
      let high: number = Number.MIN_SAFE_INTEGER;
      let low: number = Number.MAX_SAFE_INTEGER;
      for (let i = 0; i < data.length; i++) {
        const value: number = data[i];
        if (value > high) {
          high = value;
        }
        if (value < low) {
          low = value;
        }
      }
      return { high, low };
    }

    /**
     * 
     * @param values 
     * @returns - direction of values based on period
     */
    private async valueDirection(values: number[], period: number): Promise<string>{
      let sumRateOfChange = 0
      let sortArray = values.slice(-period)
      for (let i = 1; i < sortArray.length; i++) {
        const rateOfChange = (sortArray[i] - sortArray[i - 1]) / sortArray[i - 1]
        sumRateOfChange += rateOfChange
      }
      const averageRateOfChange = sumRateOfChange / (sortArray.length - 1)
      const roundedAverageRateOfChange = Math.round(averageRateOfChange * 100) / 100;
      console.log(`Average rate of rsi change: ${roundedAverageRateOfChange}`);
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
      const amount = new CryptoAmount(assetToBase(assetAmount(500, 8)), assetBUSD)
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
      const txHash = `await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)`
      console.log(txHash)
      let txRecord: TxDetail =  {
        date: new Date(),
        action: 'sell',
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length -1],
        result: txHash,
        rsi: this.rsi[this.rsi.length -1]
      }
      this.sellOrders.push(txRecord)
      await this.writeTXToFile(txRecord)
    }
  
    private async buy(tradingWallet: TradingWallet){
      const amountBUSD = new CryptoAmount(assetToBase(assetAmount(500, 8)), assetsBUSD)
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
      const txHash = `await doSingleSwap(tradingWallet.thorchainAmm, tradingWallet.wallet, swapDetail)`
      console.log(txHash)
      let txRecord: TxDetail =  {
        date: new Date(),
        action: 'buy',
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length -1],
        result: txHash,
        rsi: this.rsi[this.rsi.length -1]
      }
      this.buyOrders.push(txRecord)
      await this.writeTXToFile(txRecord)
    }

    public async timeCorrection(): Promise<Time>{
      const botStartTime = this.botConfig.startTime
      const difference = await this.getTimeDifference(botStartTime)
      console.log(botStartTime)
      return difference
    }
}