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

const oneMinuteInMs = 60 * 1000; // 1 minute in milliseconds

const rsiUpperThreshold = 70
const rsiLowerThreshold = 30

// amount to be traded in 
const tradingAmount = 400 


export class AlphaBot {
  //private pools: Record<string, LiquidityPool> | undefined
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
    console.log(bal.sbusd.formatedAssetString());
    const amount = new CryptoAmount(
      assetToBase(assetAmount(bal.sbtc.assetAmount.amount().toNumber(), 8)),
      assetsBTC
    );
    const sbusd = await this.thorchainQuery.convert(amount, assetsBUSD);
    console.log(`Btc in Busd: ${sbusd.formatedAssetString()}`)
    this.schedule();
    while (this.botConfig.botMode !== BotMode.stop) {
      let action: TradingMode;
      const tradingHalted = await this.isTradingHalted();
      if (tradingHalted) {
        action = TradingMode.paused;
      } else {
        action = await this.injestTradingData(interval);
        console.log(action);
        if (action === TradingMode.buy || action === TradingMode.sell) {
          await this.writeToFile(this.oneMinuteChart.slice(-10), action);
        }
      }
      await this.executeAction(action);
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
  private async injestTradingData(interval: string): Promise<TradingMode> {
    let market: TradingMode;
    const macd = await this.tradingIndicators.getMacd(this.fifteenMinuteChart);
    await this.tradingIndicators.getRsi(this.fifteenMinuteChart);
    await this.writeToFile(this.tradingIndicators.rsi, "rsi");
    console.log(`Collecting trading signals for ${interval}`);
    console.log(`Rsi: ${this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1]}`);
    let sellSignal: Signal;
    let buySignal: Signal;

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
      if (this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1] > 55) {
        sellSignal = await this.sellSignal(macd);
        console.log(`Sell > macd: ${sellSignal.macd}, rsi: ${sellSignal.rsi}, histo: ${sellSignal.histogram}`);
        market = await this.checkMarketType(sellSignal);
      } else if (this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1] < 45) {
        buySignal = await this.buySignal(macd);
        console.log(`Buy > macd: ${buySignal.macd}, rsi: ${buySignal.rsi}, histo: ${buySignal.histogram}`);
        market = await this.checkMarketType(buySignal);
      } else {
        market = TradingMode.hold;
      }

      return market;
    }
  }
  // ----------------------------------- Data collection for intervals -------------------------------
  public async dataCollectionMinute(start: Boolean, interval: ChartInterval) {
    this.asset = assetsBTC;
    console.log(`Collecting ${this.asset.ticker} pool price`);
    await this.readFromFile(interval);
    const highlow = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart);
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

  private async checkMarketType(signal: Signal): Promise<TradingMode> {
    const bal = await this.getSynthBalance(); // need to work on this
    const hasTxRecords = this.txRecords.length > 0;
    const amount = new CryptoAmount(
      assetToBase(assetAmount(bal.sbtc.assetAmount.amount().toNumber(), 8)),
      assetsBTC
    );
    const sbusd = await this.thorchainQuery.convert(amount, assetsBUSD);

    if (
      signal.type === TradingMode.buy &&
      bal.sbusd.assetAmount.amount().toNumber() >= tradingAmount
    ) {
      return TradingMode.buy;
    } else if (
      signal.type === TradingMode.sell &&
      sbusd.assetAmount.amount().toNumber() > tradingAmount
    ) {
      // only sell btc for more than what we bought it for
      return TradingMode.sell;
    } else {
      console.log(`Has tx records:`, hasTxRecords);
      if(signal.type === TradingMode.buy) {
        console.log(`Signal was a ${signal.type} but don't have any sbusd to buy sbtc`, );
        console.log(`Signal`,this.signalTracker.slice(-1));
      } else if( signal.type === TradingMode.sell) {
        console.log(`Signal was a ${signal.type} but don't have any btc to sell `, );
        console.log(`Signal`,this.signalTracker.slice(-1));
      }
      if (hasTxRecords)
        console.log(
          `Last tx record: `,
          this.txRecords[this.txRecords.length - 1]
        );
      return TradingMode.hold;
    }
  }


  // --------------------------------- Trading sigals ------------------------------------- 
  // private async checkHistoricSignals() {
  //   console.log(`Checking historic signals`)
  //   const minuteChart = this.oneMinuteChart
  //   const fifteenMinuteChart = minuteChart.filter(
  //     (value, index) => (index + 1) % 15 === 0
  //   );
  //   // start index is 3 hrs
  //   for (let i = 720, j = 0; i < minuteChart.length; i++, j++) {
  //     const result = rsi(minuteChart.slice(0, i + 1))
  //     const filteredResult = result.filter(
  //       (value) => value !== 100 && value !== 0
  //     );
  //     const subset = fifteenMinuteChart.slice(0, result.length);
  //     if (filteredResult.length - 1 < 45) {
  //       const macd = await this.tradingIndicators.getMacd(subset);
  //       console.log(`Rsi lower than 45`)
  //       this.tradingIndicators.checkMacdBuySignal(macd)
  //     } else if (i > 65) { 
  //       console.log(`Rsi higher than 65`)
  //       const macd = await this.tradingIndicators.getMacd(subset);
  //       this.tradingIndicators.checkMacdSellSignal(macd)
  //     }
  //   }
  // }
  
  
  private async buySignal(macdResult: MacdResult): Promise<Signal> {
    let tradeSignal: Signal = {
      type: TradingMode.hold,
      macd: false,
      rsi: false,
      histogram: false
    };
    tradeSignal.macd = this.tradingIndicators.checkMacdBuySignal(macdResult);
    const sma = await this.tradingIndicators.getSma(this.fifteenMinuteChart, 15);
    const ema = await this.tradingIndicators.getEma(this.fifteenMinuteChart, 15);
    const highLow = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart.slice(-1080));
    const psar = await this.tradingIndicators.getParabolicSar(highLow.high, highLow.low, this.fifteenMinuteChart.slice(-72));
  
    tradeSignal.histogram = macdResult.histogram[macdResult.histogram.length -1] < 0 ? true : false;
    const rsiData = await this.tradingIndicators.valueDirection(this.tradingIndicators.rsi, 12, "rsi");
    const priceDirection = await this.tradingIndicators.valueDirection(
      this.oneMinuteChart,
      10,
      "price"
    );
    console.log(`Rsi direction ${rsiData}`);
    console.log(`Price direction ${rsiData}`);
    const histogramDirection = await this.tradingIndicators.valueDirection(macdResult.histogram, 12, "histo")
    console.log(`histogram Direction`, histogramDirection)
    console.log(`sma`, sma.slice(-1), `ema`, ema.slice(-1), `psar`, psar.psar.slice(-1), `Trend:`, psar.trends.slice(-1));
    console.log(`Histogram: `, macdResult.histogram[macdResult.histogram.length -1])
    tradeSignal.rsi = await this.tradingIndicators.isRSIBuySignal(24, rsiLowerThreshold);
    // try and catch the price rebounding on the 1 minute
    const checkPriceReturn = this.tradingIndicators.checkBuySignal(this.oneMinuteChart)

    if (tradeSignal.macd && tradeSignal.rsi) {
       tradeSignal.type = TradingMode.buy
      this.signalTracker.push(`RSI: ${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, ${priceDirection}, RSI&MACD`);
     
    }
    // trade based off signals gpt reccomended 
    if (this.oneMinuteChart.slice(-1) > sma.slice(-1) && this.oneMinuteChart.slice(-1) > ema.slice(-1) && tradeSignal.macd && this.oneMinuteChart.slice(-1) > psar.psar.slice(-1)) {
      // If the current price is above SMA, EMA, MACD is positive, and above SAR, generate a buy signal
      console.log("Buy signal generated");
      tradeSignal.type = TradingMode.buy;
      this.signalTracker.push(`RSI: ${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, ${priceDirection}, GPT`);
    }
    // trade based of macd below rsi threshold and price direction
    if (tradeSignal.macd  && this.tradingIndicators.rsi[this.tradingIndicators.rsi.length -1] < 45 && tradeSignal.histogram) {
      tradeSignal.type = TradingMode.buy;
      this.signalTracker.push(`${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, ${priceDirection}, macd: ${tradeSignal.macd} RSI&MACD&HISTO`);
    }
    // Don't trade in this range
    if (!tradeSignal.macd || !tradeSignal.rsi) {
      tradeSignal.type = TradingMode.hold;
    }
    // Try and catch the wick
    if (this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1] < 15) {
       tradeSignal.type = TradingMode.buy;
      this.signalTracker.push(`${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, ${priceDirection}, Price Return ${checkPriceReturn} WICK`);
     
    }
    return tradeSignal
  }
  private async sellSignal(macdResult: MacdResult): Promise<Signal> {
    let tradeSignal: Signal = {
      type: TradingMode.hold,
      macd: false,
      rsi: false,
      histogram: false
    };

    // period being passed in is 3 hours
    tradeSignal.macd = this.tradingIndicators.checkMacdSellSignal(macdResult)
    tradeSignal.histogram = macdResult.histogram[macdResult.histogram.length -1] > 0 ? true : false
    const rsiData = await this.tradingIndicators.valueDirection(this.tradingIndicators.rsi, 12, "rsi");
    tradeSignal.rsi = await this.tradingIndicators.isRSISellSignal(24, rsiUpperThreshold);
    const priceDirection = await this.tradingIndicators.valueDirection(
      this.oneMinuteChart,
      10,
      "price"
    );
    console.log(`Rsi direction ${rsiData}`);
    console.log(`Price direction ${rsiData}`);
    const histogramDirection = await this.tradingIndicators.valueDirection(macdResult.histogram, 12, "histo")
    console.log(`histogram Direction`, histogramDirection)
    const sma = await this.tradingIndicators.getSma(this.fifteenMinuteChart, 15);
    const ema = await this.tradingIndicators.getEma(this.fifteenMinuteChart, 15);
    const highLow = await this.tradingIndicators.findHighAndLowValues(this.oneMinuteChart.slice(-1080));
    const psar = await this.tradingIndicators.getParabolicSar(highLow.high, highLow.low, this.fifteenMinuteChart.slice(-72));
    console.log(`sma`, sma.slice(-1), `ema`, ema.slice(-1), `psar`, psar.psar.slice(-1), `Trend:`, psar.trends.slice(-1));
    // try and catch the price returning on the one minute 
    const checkPriceReturn = this.tradingIndicators.checkSellSignal(this.oneMinuteChart)
 
    // Trade based off signals
    if (tradeSignal.macd && tradeSignal.rsi) {
      tradeSignal.type = TradingMode.sell
      this.signalTracker.push(`RSI&MACD ${tradeSignal.macd, tradeSignal.macd} RSI: ${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, RSI&MACD`);

    }
    // Trade based off signals gpt reccommended 
    if (this.oneMinuteChart.slice(-1) < sma.slice(-1) && this.oneMinuteChart.slice(-1) < ema.slice(-1) && tradeSignal.macd && this.oneMinuteChart.slice(-1) < psar.psar.slice(-1)) {
      // If the current price is below SMA, EMA, MACD is negative, and below SAR, generate a sell signal
      console.log("Sell signal generated");
      tradeSignal.type = TradingMode.sell;
      this.signalTracker.push(`RSI&MACD ${tradeSignal.macd, tradeSignal.macd} RSI: ${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, GPT`);
    }
    // Trade macd above rsi threshold
    if (tradeSignal.macd && this.tradingIndicators.rsi[this.tradingIndicators.rsi.length -1] > 65 && tradeSignal.histogram ) {
      tradeSignal.type = TradingMode.hold;
      this.signalTracker.push(`RSI: ${this.tradingIndicators.rsi.slice(-1)} ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type},  ${priceDirection} macd: ${tradeSignal.macd} histo&rsi&Macd`);
    }
    // Dont trade this range
    if (!tradeSignal.macd || !tradeSignal.rsi) {
      tradeSignal.type = TradingMode.hold;
    }
    // Try and catch the wick 
    if (this.tradingIndicators.rsi[this.tradingIndicators.rsi.length - 1] > 85 && checkPriceReturn) {
      tradeSignal.type = TradingMode.sell;
      this.signalTracker.push(`RSI: ${this.tradingIndicators.rsi.slice(-1)}, ${this.oneMinuteChart.slice(-1)}, ${tradeSignal.type}, Price Return: ${checkPriceReturn} WICK`);
    }
    return tradeSignal
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
    const bal = await this.getSynthBalance(); // need to work on this
    const sbtc = new CryptoAmount(assetToBase(assetAmount(tradingAmount)), bal.sbtc.asset)

    const address = "thor1nx3yxgdw94nfw0uzwns2ay5ap85nk9p6hjaqn9";
    const fromAsset = assetsBTC;
    const destinationAsset = assetsBUSD;
    const swapDetail: SwapDetail = {
      amount: sbtc,
      decimals: 8,
      fromAsset,
      destinationAsset,
      desstinationAddress: address,
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
  }

  private async buy(tradingWallet: TradingWallet) {
    const bal = await this.getSynthBalance();
    const sbusd = new CryptoAmount(assetToBase(assetAmount(tradingAmount)), bal.sbusd.asset)
    const address = "thor1nx3yxgdw94nfw0uzwns2ay5ap85nk9p6hjaqn9";
    const fromAsset = assetsBUSD;
    const destinationAsset = assetsBTC;
    const swapDetail: SwapDetail = {
      amount: sbusd,
      decimals: 8,
      fromAsset,
      destinationAsset,
      desstinationAddress: address,
    };
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
    try {
      const address = this.wallet.clients[THORChain].getAddress();
      const balance = this.wallet.clients[THORChain].getBalance(address);
      const bitcoin = (await balance).find(
        (asset) => asset.asset.ticker === synthbtc.ticker
      ).amount;
      const busd = (await balance).find(
        (asset) => asset.asset.ticker === synthBUSD.ticker
      ).amount;
      const sbalance: SynthBalance = {
        sbtc: new CryptoAmount(bitcoin, assetsBTC),
        sbusd: new CryptoAmount(busd, assetsBUSD),
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
      const amount = new CryptoAmount(
        assetToBase(assetAmount(bal.sbtc.assetAmount.amount().toNumber(), 8)),
        assetsBTC
      );
      const sbusd = await this.thorchainQuery.convert(amount, assetsBUSD);
      console.log(`Btc in Busd: ${sbusd.formatedAssetString()}`)
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
    if(Number(timeAlive.timeInHours) % 3) {
      await this.writeSignalToFile(this.signalTracker);
    }
    console.log(`Minute Chart length: `, this.oneMinuteChart.length);
    console.log(`Buy orders: `, this.buyOrders.length);
    console.log(`Sell orders: `, this.sellOrders.length);
    console.log(`Signals : `, this.signalTracker.slice(-100));
  }
}
