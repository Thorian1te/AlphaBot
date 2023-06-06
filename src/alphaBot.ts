import * as fs from "fs";

import { ThorchainAMM, Wallet } from "@xchainjs/xchain-thorchain-amm";
import {
  CryptoAmount,
  Midgard,
  ThorchainCache,
  ThorchainQuery,
  Thornode,
} from "@xchainjs/xchain-thorchain-query";
import { decryptFromKeystore } from "@xchainjs/xchain-crypto";
import { Network } from "@xchainjs/xchain-client";
import {
  THORChain,
} from "@xchainjs/xchain-thorchain";
import {
  assetAmount,
  assetFromStringEx,
  delay,
  assetToBase,
  Asset,
  baseAmount,
} from "@xchainjs/xchain-util";
import { doSingleSwap } from "./doSwap";
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
} from "./types";
import {TradingIndicators} from './tradingIndicators'

require("dotenv").config();

const assetsBUSD = assetFromStringEx(`BNB/BUSD-BD1`);
const assetsBTC = assetFromStringEx(`BTC/BTC`);
const assetsBTCB = assetFromStringEx(`BNB/BTCB-1DE`)

const oneMinuteInMs = 60 * 1000; // 1 minute in milliseconds

const rsiUpperThreshold = 70
const rsiLowerThreshold = 30

// amount to be traded in 
const tradingAmount = 400

const tradePercentage = 0.03 //represented as a number


export class AlphaBot {
  private thorchainCache: ThorchainCache;
  private thorchainQuery: ThorchainQuery;
  private tradingIndicators: TradingIndicators

  private txRecords: TxDetail[] = [];
  private sellOrders: TxDetail[] = [];
  private buyOrders: TxDetail[] = [];

  public oneMinuteChart: number[] = [];
  public fiveMinuteChart: number[] = [];
  public fifteenMinuteChart: number[] = [];
  public halfHourChart: number[] = [];
  public OneHourChart: number[] = [];
  public rsi: number[] = [];
  private signalTracker: string[] = [];

  private thorchainAmm: ThorchainAMM;
  private keystore1FilePath: string;
  private keystore1Password: string;
  private wallet: Wallet | undefined;
  private pauseTimeSeconds: number;
  private asset: Asset;
  private botConfig: BotInfo = {
    botMode: BotMode.runIdle,
    walletStatus: "initialized",
    dataCollection: true,
    startTime: new Date(),
    tradingMode: TradingMode.hold,
  };
  private interval: number;
  private intervalId: NodeJS.Timeout | undefined;

  constructor(
    network: Network,
    keystore1FilePath: string,
    keystore1Password: string,
    pauseTimeSeconds: number
  ) {
    this.keystore1FilePath = keystore1FilePath;
    this.keystore1Password = keystore1Password;
    this.pauseTimeSeconds = pauseTimeSeconds;
    this.thorchainCache = new ThorchainCache(
      new Midgard(network),
      new Thornode(network)
    );
    this.thorchainQuery = new ThorchainQuery(this.thorchainCache);
    this.thorchainAmm = new ThorchainAMM(this.thorchainQuery);
    this.tradingIndicators = new TradingIndicators();
    this.interval = 10 * 60 * 1000; // 10 minutes in milliseconds
  }

  private async walletSetup() {
    const keystore = JSON.parse(
      fs.readFileSync(this.keystore1FilePath, "utf8")
    );
    const phrase1 = await decryptFromKeystore(keystore, this.keystore1Password);

    this.wallet = new Wallet(phrase1, this.thorchainQuery);
  }

  async start(interval: ChartInterval) {
    console.log(`Start time: ${this.botConfig.startTime}`);
    console.log("Setting up wallet");
    await this.walletSetup();
    console.log("Running AlphaBot....");
    const bal = await this.getSynthBalance();
    console.log(bal.sbtc.formatedAssetString());
    console.log(bal.sbtcb.baseAmount !== null ? bal.sbtcb.formatedAssetString() : `BTCB: 0`);
    console.log(bal.sbusd.formatedAssetString());
    const sbusdworthofbtc = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD);
    const sbusdworthofbtcb = await this.thorchainQuery.convert(bal.sbtcb, assetsBUSD);
    console.log(`Btc in Busd: ${sbusdworthofbtc.formatedAssetString()}`)
    console.log(`BtcB in Busd: ${sbusdworthofbtcb.formatedAssetString()}`)
    this.schedule();
    this.readLastBuyTrade()
    this.readLastSellTrade()
    while (this.botConfig.botMode !== BotMode.stop) {
      let action: TradingMode;
      const tradingHalted = await this.isTradingHalted();
      if (tradingHalted) {
        action = TradingMode.paused;
      } else {
        await this.injestTradingData(interval);
      }
    }
    if (this.oneMinuteChart.length > 1080) {
      await this.readFromFile(ChartInterval.OneMinute);
    }
  }

  private async executeAction(action: TradingMode) {
    const tradingWallet = await this.openWallet(this.keystore1Password);
    switch (action) {
      case TradingMode.buy:
        await this.buy(tradingWallet);
        break;
      case TradingMode.sell:
        await this.sell(tradingWallet);
        break;
      case TradingMode.hold:
        await delay(this.pauseTimeSeconds * 999);
        break;
      case TradingMode.paused:
        const tradingHalted = await this.isTradingHalted();
        while(tradingHalted) {
          console.log(`Trading is ${action}, will retry in 10 seconds`)
          await delay(this.pauseTimeSeconds * 10000);
        }
        break;
      default:
        break;
    }
  }
  private async injestTradingData(interval: string) {
    let market: TradingMode;
    const macd = await this.tradingIndicators.getMacd(this.fifteenMinuteChart);
    await this.tradingIndicators.getRsi(this.fifteenMinuteChart);
    await this.writeToFile(this.tradingIndicators.rsi, "rsi");
    console.log(`Collecting trading signals for ${interval}`);
    console.log(`Rsi: ${this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1]}`);
    let signal: Signal;
    if(this.buyOrders.slice(-1)[0].date > this.sellOrders.slice(-1)[0].date ) {
      if(this.txRecords.length < 1) this.txRecords.push(this.buyOrders.slice(-1)[0])
    } else {
      if(this.txRecords.length < 1) this.txRecords.push(this.sellOrders.slice(-1)[0])
    }

    console.log(
      `Last Price: ${this.asset.chain} $`,
      this.oneMinuteChart[this.oneMinuteChart.length - 1]
    );
    if (this.fiveMinuteChart.length - 1 < 72) {
      const percentageComplete = ((this.fiveMinuteChart.length - 1) / 72) * 100;
      console.log(
        `Alphabot is waiting for data maturity: ${percentageComplete.toFixed()} % complete`
      );
      return TradingMode.hold;
    } else {
      signal = await this.signal(macd);
      console.log(signal)
      market = await this.checkWalletBal(signal);
      await this.executeAction(market);
    }
  }
  // ----------------------------------- Data collection for intervals -------------------------------
  public async dataCollectionMinute(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC;
    console.log(`Collecting ${this.asset.ticker} pool price`);
    await this.readFromFile(interval);
    const highlow = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart, 1080);
    console.log(`One minute chart highs and lows`, highlow.high.slice(-1), highlow.low.slice(-1));

    while (start) {
      // One minute
      await this.getAssetPrice(interval);
      await this.writeToFile(this.oneMinuteChart, interval);
      await delay(oneMinuteInMs);
      if (this.oneMinuteChart.length > 1080) {
        const excess = this.oneMinuteChart.length - 1080;
        this.oneMinuteChart.splice(0, excess);
      }
    }
  }
  public async dataCollectionFiveMinutes(
    start: Boolean,
    interval: ChartInterval
  ) {
    while (start) {
      const filtered = this.oneMinuteChart.filter(
        (value, index) => (index + 1) % 5 === 0
      );
      if (this.fiveMinuteChart.length < 1) {
        this.fiveMinuteChart.push(...filtered);
      } else {
        const lastEntryFive =
          this.fiveMinuteChart[this.fiveMinuteChart.length - 1];
        const lastFilterd = filtered[filtered.length - 1];
        if (lastFilterd !== lastEntryFive) {
          this.fiveMinuteChart.push(lastFilterd);
        }
      }
      await this.writeToFile(this.fiveMinuteChart, interval);
      await delay(oneMinuteInMs * 5);
    }
  }
  public async dataCollectionFifteenMinutes(
    start: Boolean,
    interval: ChartInterval
  ) {
    while (start) {
      const filtered = this.oneMinuteChart.filter(
        (value, index) => (index + 1) % 15 === 0
      );
      if (this.fifteenMinuteChart.length < 1) {
        this.fifteenMinuteChart.push(...filtered);
      } else {
        const lastEntryFive =
          this.fifteenMinuteChart[this.fifteenMinuteChart.length - 1];
        const lastFilterd = filtered[filtered.length - 1];
        if (lastFilterd !== lastEntryFive) {
          this.fifteenMinuteChart.push(lastFilterd);
        }
      }
      await this.writeToFile(this.fifteenMinuteChart, interval);
      await delay(oneMinuteInMs * 15);
    }
  }
  public async dataCollectionHalfHour(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter(
        (value, index) => (index + 1) % 30 === 0
      );
      if (this.halfHourChart.length < 1) {
        this.halfHourChart.push(...filtered);
      } else {
        const lastEntryFive = this.halfHourChart[this.halfHourChart.length - 1];
        const lastFilterd = filtered[filtered.length - 1];
        if (lastFilterd !== lastEntryFive) {
          this.halfHourChart.push(lastFilterd);
        }
      }
      await this.writeToFile(this.halfHourChart, interval);
      await delay(oneMinuteInMs * 30);
    }
  }
  public async dataCollectionOneHour(start: Boolean, interval: ChartInterval) {
    while (start) {
      const filtered = this.oneMinuteChart.filter(
        (value, index) => (index + 1) % 60 === 0
      );
      if (this.OneHourChart.length < 1) {
        this.OneHourChart.push(...filtered);
      } else {
        const lastEntryFive = this.OneHourChart[this.OneHourChart.length - 1];
        const lastFilterd = filtered[filtered.length - 1];
        if (lastFilterd !== lastEntryFive) {
          this.OneHourChart.push(lastFilterd);
        }
      }
      await this.writeToFile(this.OneHourChart, interval);
      await delay(oneMinuteInMs * 60);
    }
  }
  /** 
/** Fetch price function 
 * 
 * @param chartInterval - chart interval in minutes
 */
  private async getAssetPrice(chartInterval: string) {
    console.log(
      `Fecthing data at interval ${chartInterval} for asset ${this.asset.ticker}`
    );
    try {
      const assetPool = await this.thorchainCache.getPoolForAsset(this.asset);
      const assetPrice = Number(assetPool.pool.assetPriceUSD);
      const price = Number(assetPrice.toFixed(2));
      this.oneMinuteChart.push(price);
    } catch (err) {
      console.log(`Error fetching price ${err}`);
    }
  }

  private async getTimeDifference(startTime: Date): Promise<Time> {
    const currentTime = new Date();
    const difference = currentTime.getTime() - startTime.getTime();
    const time: Time = {
      timeInSeconds: difference / 1000,
      timeInMinutes: difference / 1000 / 60,
      timeInHours: difference / 1000 / 60 / 60,
    };
    return time;
  }

  private async checkWalletBal(signal: Signal): Promise<TradingMode> {
    const bal = await this.getSynthBalance(); 
    const hasTxRecords = this.txRecords.length > 0;
    const sbusd = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD);
    if (signal.type === TradingMode.buy) {
      console.log(bal.sbusd.formatedAssetString());
      const decision = bal.sbusd.assetAmount.amount().toNumber() > 400 ? TradingMode.buy : TradingMode.hold
      return decision;
    } else if (signal.type === TradingMode.sell) {
      console.log(bal.sbtc.formatedAssetString());
      const decision = sbusd.assetAmount.amount().toNumber() > 400 ? TradingMode.sell : TradingMode.hold
      return decision;
    } else {
      if (hasTxRecords) {
      console.log('Last tx record:', this.txRecords[this.txRecords.length - 1]);
      }
      console.log(sbusd.assetAmount.amount().toNumber()) 
      return TradingMode.hold;
    }
  }
  
  private async signal(macdResult: MacdResult): Promise<Signal> {
    let tradeSignal: Signal = {
      type: TradingMode.hold,
      macd: false,
      rsi: false,
      histogram: false
    };

    // period being passed in is 3 hours

    tradeSignal.histogram = macdResult.histogram[macdResult.histogram.length -1] > 0 ? true : false
    const rsiData = await this.tradingIndicators.valueDirection(this.tradingIndicators.rsi, 12, "rsi");
    tradeSignal.rsi = await this.tradingIndicators.isRSISellSignal(24, rsiUpperThreshold);
    const sma = await this.tradingIndicators.getSma(this.fifteenMinuteChart, 15);
    const ema = await this.tradingIndicators.getEma(this.fifteenMinuteChart, 15);
    const highLowPastFifteenMinutes = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart.slice(-1080), 15);
    const highLowPastThreeHours = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart.slice(-180), 180)
    console.log(`Past three hours \nHigh ${highLowPastThreeHours.high} \nLow ${highLowPastThreeHours.low}`)
    const psar = await this.tradingIndicators.getParabolicSar(highLowPastFifteenMinutes.high, highLowPastFifteenMinutes.low, this.fifteenMinuteChart.slice(-72));

    // try and catch the price returning on the one minute 
    const checkPriceReturn = this.tradingIndicators.checkSellSignal(this.oneMinuteChart)

    // Check percentage gained 
    const percentageGained = this.percentageChangeFromTrade()
    console.log(`Percentage changed since ${this.txRecords.slice(-1)[0].action}, ${percentageGained}`)

    // analyse ema sam and psar
    const tradeDecision = await this.tradingIndicators.analyzeTradingSignals(psar.psar, sma, ema)

    if(tradeDecision === TradingMode.sell) {
      tradeSignal.macd = this.tradingIndicators.checkMacdSellSignal(macdResult)
      // Trade based off macd only 
      if(tradeSignal.macd){
        console.log(`macd: ${tradeSignal.macd} Price return ${checkPriceReturn}`)
        this.signalTracker.push(`MACD crossed below the signal, sell signal confirmed, Rsi direction ${rsiData} PRice return ${checkPriceReturn}`)
        tradeSignal.type = TradingMode.sell
      }
      // trade on the psar 
      for (let i = 0; i < psar.psar.length; i++) {
        if (psar.trends[i] > 0 && psar[i] < this.fifteenMinuteChart[i]) {
          console.log(`Psar flash sell signal, \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          this.signalTracker.push(`Psar flash sell signal, \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          tradeSignal.type = TradingMode.sell
        } else if (psar.trends[i] < 0 && psar[i] > this.fifteenMinuteChart[i]) {
          console.log(`Psar flash buy signal \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          this.signalTracker.push(`Psar flash buy signal \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          tradeSignal.type = TradingMode.buy
        } else {
          tradeSignal.type = tradeDecision
        }
      }
      return tradeSignal
    } else if ( tradeDecision === TradingMode.buy) {
      tradeSignal.macd = this.tradingIndicators.checkMacdBuySignal(macdResult);
      // Trade based off macd only 
      if(tradeSignal.macd){
        console.log(`macd: ${tradeSignal.macd} Price return ${checkPriceReturn}`)
        this.signalTracker.push(`MACD crossed above the signal, buy signal confirmed. Rsi direction ${rsiData}`)
        tradeSignal.type = TradingMode.buy
      }
      // trade on the psar 
      for (let i = 0; i < psar.psar.length; i++) {
        if (psar.trends[i] > 0 && psar[i] < this.fifteenMinuteChart[i]) {
          console.log(`Psar flash sell signal, \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          this.signalTracker.push(`Psar flash sell signal, \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          tradeSignal.type = TradingMode.sell
        } else if (psar.trends[i] < 0 && psar[i] > this.fifteenMinuteChart[i]) {
          console.log(`Psar flash buy signal \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          this.signalTracker.push(`Psar flash buy signal \nLast Price: ${this.asset.chain} ${this.oneMinuteChart[this.oneMinuteChart.length - 1]}`)
          tradeSignal.type = TradingMode.buy
        } else {
          tradeSignal.type = tradeDecision
        }
      }
      return tradeSignal
    } else {
      tradeSignal.type = tradeDecision
      return tradeSignal
    }
  }


  private percentageChangeFromTrade(): number {
    if (this.txRecords.length === 0) {
      throw new Error("No buy orders available");
    }
  
    const lastTradePrice = this.txRecords[0].assetPrice;
    const assetPrice = +this.oneMinuteChart.slice(-1)[0];
    if (isNaN(assetPrice)) {
      throw new Error("Invalid asset price");
    }
  
    const percentageChange = ((assetPrice - lastTradePrice) / lastTradePrice);
    return percentageChange;
  }
  

  // ---------------------------- file sync ---------------------------------
  /**
   *
   * @param chart
   * @param interval
   */
  private async writeToFile(chart: number[], interval: string) {
    fs.writeFileSync(
      `./priceData/${interval}${this.asset.ticker}Data.json`,
      JSON.stringify(chart, null, 4),
      "utf8"
    );
  }

  private async writeTXToFile(transaction: TxDetail) {
    fs.writeFileSync(
      `./${transaction.action}${transaction.asset.ticker}txRecords.json`,
      JSON.stringify(transaction, null, 4),
      "utf8"
    );
  }
  private async writeSignalToFile(signal: string[]) {
    const currentTime = new Date();
    fs.writeFileSync(
      `./signal/${currentTime.getDate()}Signal.json`,
      JSON.stringify(signal, null, 4),
      "utf8"
    );
  }

  /**
   *
   * @param chartInterval - input
   */
  private async readFromFile(interval: ChartInterval) {
    const result: number[] = JSON.parse(
      fs.readFileSync(`./priceData/${interval}BTCData.json`, "utf8")
    );
    const chopped = result.slice(-1080);

    for (let i = 0; i < chopped.length; i++) {
      let resp = chopped[i];
      if (resp != null) {
        this.oneMinuteChart.push(resp);
      }
    }
  }
  private async readLastSellTrade() {
    const result: TxDetail = JSON.parse(
      fs.readFileSync(`sellBTCtxRecords.json`, "utf8")
    );
    if(this.sellOrders.slice(-1)[0] != result){
      this.sellOrders.push(result)
    }

  }
  private async readLastBuyTrade() {
    const result: TxDetail = JSON.parse(
      fs.readFileSync(`buyBUSDtxRecords.json`, "utf8")
    );
    if(this.buyOrders.slice(-1)[0] != result){
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
    const keystore1 = JSON.parse(
      fs.readFileSync(this.keystore1FilePath, "utf8")
    );
    const seed = await decryptFromKeystore(keystore1, password);
    const thorchainCache = new ThorchainCache(new Midgard(), new Thornode());
    const thorchainQuery = new ThorchainQuery(thorchainCache);
    this.wallet = new Wallet(seed, thorchainQuery);
    const tradingWallet: TradingWallet = {
      wallet: this.wallet,
      thorchainAmm: this.thorchainAmm,
    };
    return tradingWallet;
  }


  /**
   *
   * @param tradingWallet
   */
  private async sell(tradingWallet: TradingWallet) {
    const bal = await this.getSynthBalance(); 

    const sbusd = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD);
    const sellAmount = sbusd.assetAmount.amount().toNumber() - 1
    const busdMinusOne = new CryptoAmount(assetToBase(assetAmount(sellAmount)), assetsBUSD)
    const sythBTC = await this.thorchainQuery.convert(busdMinusOne, bal.sbtc.asset)
    // do we have more than 400 dollars of btc
    if(sbusd.assetAmount.amount().toNumber() > 400) {
      const fromAsset = bal.sbtc.asset
      // sell the balance
      const destinationAsset = assetsBUSD;
      const swapDetail: SwapDetail = {
        amount: sythBTC,
        decimals: 8,
        fromAsset,
        destinationAsset,
      };
      const txHash = await doSingleSwap(
        tradingWallet.thorchainAmm,
        tradingWallet.wallet,
        swapDetail
      );
      console.log(txHash);
      let txRecord: TxDetail = {
        date: new Date(),
        action: TradingMode.sell,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length - 1],
        result: txHash,
        rsi: this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1],
      };
      this.sellOrders.push(txRecord);
      this.txRecords.push(txRecord);
      await delay(12 * 1000);
      await this.writeTXToFile(txRecord);

    }else {
      this.signalTracker.push(`Balance BTC synth: ${bal.sbtc.assetAmount.amount().toNumber()}`)
    }

  }

  private async buy(tradingWallet: TradingWallet) {
    const pools = await this.thorchainCache.thornode.getPools()
    const btcSynthPaused = pools.find((pool) => pool.asset === `${assetsBTC.chain}.${assetsBTC.symbol}`)

    const sbusd = new CryptoAmount(assetToBase(assetAmount(tradingAmount)), assetsBUSD)
    const fromAsset = assetsBUSD;
    const destinationAsset =  assetsBTC;
    const swapDetail: SwapDetail = {
      amount: sbusd,
      decimals: 8,
      fromAsset,
      destinationAsset,
    };
    if (! btcSynthPaused.synth_mint_paused) {
      const txHash = await doSingleSwap(
        tradingWallet.thorchainAmm,
        tradingWallet.wallet,
        swapDetail
      );
      console.log(txHash);
      let txRecord: TxDetail = {
        date: new Date(),
        action: TradingMode.buy,
        asset: fromAsset,
        amount: swapDetail.amount.formatedAssetString(),
        assetPrice: this.oneMinuteChart[this.oneMinuteChart.length - 1],
        result: txHash,
        rsi: this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1],
      };
      this.buyOrders.push(txRecord);
      this.txRecords.push(txRecord);
      await delay(12 * 1000);
      await this.writeTXToFile(txRecord);
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
    const difference = await this.getTimeDifference(botStartTime);
    return difference;
  }
  /**
   *
   * @returns - Synth balance for the wallet
   */
  private async getSynthBalance(): Promise<SynthBalance> {
    let synthbtc = assetsBTC;
    let synthBUSD = assetsBUSD;
    let synthBTCB = assetsBTCB;

    try {
      const address = this.wallet.clients[THORChain].getAddress();
      const balance = await this.wallet.clients[THORChain].getBalance(address);
      const bitcoinBal = balance.find(
        (asset) => asset.asset.ticker === synthbtc.ticker
      ) ? balance.find((asset) => asset.asset.ticker === synthbtc.ticker).amount : null;
      const busdBal = balance.find(
        (asset) => asset.asset.ticker === synthBUSD.ticker
      ) ? balance.find((asset) => asset.asset.ticker === synthBUSD.ticker).amount : null;
      const btcbBal = balance.find(
        (asset) => asset.asset.ticker === synthBTCB.ticker
      ) ? balance.find((asset) => asset.asset.ticker === synthBTCB.ticker).amount : null
      
      const sbalance: SynthBalance = {
        sbusd: new CryptoAmount(busdBal, assetsBUSD),
        sbtc: new CryptoAmount(bitcoinBal, assetsBTC),
        sbtcb: btcbBal !== null ?  new CryptoAmount(btcbBal, assetsBTCB) : new CryptoAmount(baseAmount(0), assetsBTCB) ,
      };
      return sbalance;
    } catch (error) {
      console.log(`Error fetching bal: `, error)
    }
    
  }

  private async isTradingHalted(): Promise<boolean> {
    const checkMimr = await this.thorchainCache.thornode.getMimir();
    const isTradinghalted = checkMimr["HALTTHORCHAIN"];
    if (Number(isTradinghalted) === 0) {
      return false;
    } else {
      return true;
    }
  }

  private schedule(): void {
    console.log("Starting scheduled task...");
    this.intervalId = setInterval(async () => {
      const currentTime = new Date();
      if (currentTime >= this.botConfig.startTime) {
        await this.displayData();
      }
    }, this.interval);
  }

  private async displayData() {
    const timeAlive = await this.getTimeDifference(this.botConfig.startTime)
    try {
      const bal = await this.getSynthBalance();
      console.log(bal.sbtc.formatedAssetString());
      console.log(bal.sbusd.formatedAssetString());
      const sbusdworthofbtc = await this.thorchainQuery.convert(bal.sbtc, assetsBUSD);
      const sbusdworthofbtcb = await this.thorchainQuery.convert(bal.sbtcb, assetsBUSD);
      console.log(`Btc in Busd: ${sbusdworthofbtc.formatedAssetString()}`)
      console.log(`BtcB in Busd: ${sbusdworthofbtcb.formatedAssetString()}`)
    }catch (err) {console.log(`Can't fetch balances`)}

    console.log(`Buy records: `, this.buyOrders.length);
    console.log(`Sell records: `, this.sellOrders.length);
    console.log(
      `Time alive: `,
      Number(timeAlive.timeInMinutes) >
        1080
        ? timeAlive.timeInHours
        : timeAlive.timeInMinutes
    );
    if(Number(timeAlive.timeInHours) % 2 && this.signalTracker.length > 1) {
      await this.writeSignalToFile(this.signalTracker);
    }
    console.log(`Minute Chart length: `, this.oneMinuteChart.length);
    console.log(`Buy orders: `, this.buyOrders.length);
    console.log(`Sell orders: `, this.sellOrders.length);
    console.log(`Signals : `, this.signalTracker.slice(-10));
  }
}
