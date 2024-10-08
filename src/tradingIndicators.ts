import { ema, macd, rsi, sma, parabolicSar } from 'indicatorts'
import { HighAndLow, MacdResult, ParabolicSar, Time, TradeAnalysis, TradingMode, TxDetail } from './types'

export class TradingIndicators {
  public rsi: number[] = []
  private currentRsi: number[] = []
  private currentOneMinuteChart: number[] = []
  // ------------------------------------- Trading Indicators ----------------------------------------

  /**
   *
   * @param values array of price data
   * @param period what period to calculate by
   * @returns
   */
  public getEma(values: number[], period: number): number[] {
    const result = ema(period, values)
    return result
  }
  /**
   *
   * @param values - fifteenminute chart
   * @param period - 15
   * @returns
   */
  public getSma(values: number[], period: number): number[] {
    const result = sma(period, values)
    return result
  }

  /**
   *
   * @param highs - highs for chart interval
   * @param lows - lows for chart interval
   * @param closing - closings for chart interval
   * @returns
   */
  public async getParabolicSar(highs: number[], lows: number[], closing: number[]): Promise<ParabolicSar> {
    const result = parabolicSar(highs, lows, closing)
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
  }
  /**
   *
   * @param closings - chart closings
   * @returns
   */
  public async getMacd(closings: number[]): Promise<MacdResult> {
    const result = macd(closings)
    const histogram = this.calculateMacdHistogram(result.macdLine, result.signalLine)
    const macdHistogram: MacdResult = {
      macdLine: result.macdLine,
      signalLine: result.signalLine,
      histogram: histogram,
    }
    return macdHistogram
  }

  // Function to calculate MACD histogram
  private calculateMacdHistogram = (macdLine, signalLine) => {
    const macdHistogram = []
    for (let i = 0; i < macdLine.length; i++) {
      const histogramValue = macdLine[i] - signalLine[i]
      macdHistogram.push(histogramValue)
    }
    return macdHistogram
  }

  /**
   *
   * @param chart
   * @returns
   */
  public checkBuySignal(chart: number[]) {
    const currentPeriod = chart.length - 1
    const previousPeriod = currentPeriod - 1
    const prePreviousPeriod = currentPeriod - 2

    if (chart[currentPeriod] > chart[previousPeriod] && chart[previousPeriod] < chart[prePreviousPeriod]) {
      // Price was previously decreasing and just crossed above the previous period,
      // and the previous period was also decreasing,
      // generate a buy signal
      console.log('Price crossed above the previous period')
      return true
    } else {
      console.log(`Current price period:`, chart[currentPeriod])
      console.log(`Previous price period:`, chart[previousPeriod])
      return false
    }
  }
  /**
   *
   * @param chart 1-minute price chart
   * @returns true if a sell signal is generated, false otherwise
   */
  public checkSellSignal(chart: number[]) {
    const currentPeriod = chart.length - 1
    const previousPeriod = currentPeriod - 1
    const prePreviousPeriod = currentPeriod - 2

    if (chart[currentPeriod] < chart[previousPeriod] && chart[previousPeriod] > chart[prePreviousPeriod]) {
      // Price was previously increasing and just crossed below the previous period,
      // and the previous period was also increasing,
      // generate a sell signal
      console.log('Price crossed below the previous period')
      return true
    } else {
      console.log(`Current price period: ${chart[currentPeriod]}`)
      console.log(`Previous price period: ${chart[previousPeriod]}`)
      return false
    }
  }

  public determineDirection(currentSMA: number, previousSMA: number): string {
    if (currentSMA > previousSMA) {
      return 'Upward'
    } else if (currentSMA < previousSMA) {
      return 'Downward'
    } else {
      return 'Stable'
    }
  }

  /**
   *
   * @param macdResult
   * @returns
   */
  public checkMacdBuySignal(macdResult: MacdResult) {
    const currentPeriod = macdResult.macdLine.length - 1
    const previousPeriod = currentPeriod - 1
    const prePreviousPeriod = currentPeriod - 2

    if (
      macdResult.macdLine[currentPeriod] > macdResult.signalLine[currentPeriod] &&
      macdResult.macdLine[previousPeriod] < macdResult.signalLine[previousPeriod] &&
      macdResult.macdLine[prePreviousPeriod] < macdResult.signalLine[prePreviousPeriod]
    ) {
      // MACD lines were previously below the signal line and just crossed above,
      // and previous MACD lines were also below the signal line,
      // generate a buy signal
      console.log('MACD crossed above the signal')
      return true
    } else {
      console.log(`Current MACD period: ${macdResult.macdLine[currentPeriod]}`)
      console.log(`Current signal period: ${macdResult.signalLine[currentPeriod]}`)
      return false
    }
  }
  /**
   *
   * @param macdResult
   * @returns
   */
  public checkMacdSellSignal(macdResult: MacdResult) {
    const lastMacd = macdResult.macdLine[macdResult.macdLine.length - 1]
    const secondLastMacd = macdResult.macdLine[macdResult.macdLine.length - 2]
    const lastSignal = macdResult.signalLine[macdResult.signalLine.length - 1]
    const secondLastSignal = macdResult.signalLine[macdResult.signalLine.length - 2]

    const previousMacd = macdResult.macdLine[macdResult.macdLine.length - 3]
    const previousSignal = macdResult.signalLine[macdResult.signalLine.length - 3]

    if (lastMacd < lastSignal && secondLastMacd > secondLastSignal && previousMacd > previousSignal) {
      // MACD lines were previously above the signal line and just crossed below,
      // and previous MACD lines were also above the signal line,
      // generate a sell signal

      console.log('MACD crossed below the signal, sell signal confirmed')
      return true
    } else {
      console.log(`Current period MACD: ${lastMacd}`)
      console.log(`Current period signal: ${lastSignal}`)
      return false
    }
  }

  /**
   *
   * @param period
   * @param rsiLowerThreshold
   * @returns
   */
  public async isRSIBuySignal(period: number, rsiLowerThreshold: number): Promise<boolean> {
    const currentRSI = this.rsi[this.rsi.length - 1]

    if (currentRSI >= rsiLowerThreshold) {
      return false
    }

    const startIndex = Math.max(this.rsi.length - period, 1)
    if (startIndex === 1 && this.rsi[0] >= rsiLowerThreshold) {
      return false
    }

    for (let i = startIndex; i < this.rsi.length; i++) {
      const currentRSIInLoop = this.rsi[i]
      const previousRSIInLoop = this.rsi[i - 1]

      if (previousRSIInLoop < rsiLowerThreshold && currentRSIInLoop >= rsiLowerThreshold) {
        console.log('RSI dipped below threshold and is rebounding')
        return true // Buy signal confirmed
      }
    }

    return false // No buy signal detected
  }
  /**
   *
   * @param period
   * @param rsiUpperThreshold
   * @returns
   */
  public async isRSISellSignal(period: number, rsiUpperThreshold: number): Promise<boolean> {
    const currentRSI = this.rsi[this.rsi.length - 1]

    if (currentRSI <= rsiUpperThreshold) {
      return false
    }

    const startIndex = Math.max(this.rsi.length - period, 1)
    if (startIndex === 1 && this.rsi[0] <= rsiUpperThreshold) {
      return false
    }

    for (let i = startIndex; i < this.rsi.length; i++) {
      const currentRSIInLoop = this.rsi[i]
      const previousRSIInLoop = this.rsi[i - 1]
      if (previousRSIInLoop > rsiUpperThreshold && currentRSIInLoop <= rsiUpperThreshold) {
        console.log('Rsi is above sell threshold and is returning')
        return true // Sell signal confirmed
      }
    }

    return false // No sell signal detected
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

  /** Helper function to find highs and lows in an array
   *
   * @param data - input array
   * @returns
   */
  public findHighAndLowValues(data: number[], period: number): HighAndLow {
    const highArray: number[] = []
    const lowArray: number[] = []
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

      // Check for high and low values every period values
      if ((i + 1) % period === 0) {
        // Push high and low values to the respective arrays
        highArray.push(high)
        lowArray.push(low)
        // Reset high and low values for the next period values
        high = Number.MIN_SAFE_INTEGER
        low = Number.MAX_SAFE_INTEGER
      }
    }
    const highAndLowArray: HighAndLow = {
      high: highArray,
      low: lowArray,
    }
    return highAndLowArray
  }

  public detectTop(prices: number[], reversalThreshold: number, arraylength: number) {
    let highestPrice = -Infinity
    let highestIndex = -1
    let previousPrice = -Infinity
    let previousIndex = -1
    let isTrendReversal = false

    for (let i = prices.length - 1; i >= prices.length - arraylength; i--) {
      if (prices[i] > highestPrice) {
        previousPrice = highestPrice
        previousIndex = highestIndex
        highestPrice = prices[i]
        highestIndex = i

        // Check for trend reversal or significant price change
        if (previousIndex >= 0 && (highestPrice - previousPrice) / previousPrice >= reversalThreshold) {
          isTrendReversal = true
        } else {
          isTrendReversal = false
        }
      }
    }

    return {
      highest: highestPrice,
      index: highestIndex,
      isTrendReversal: isTrendReversal,
    }
  }

  public detectBottom(prices: number[], reversalThreshold: number, arraylength: number) {
    let lowestPrice = Infinity
    let lowestIndex = -1
    let previousPrice = Infinity
    let previousIndex = -1
    let isTrendReversal = false

    for (let i = prices.length - 1; i >= prices.length - arraylength; i--) {
      if (prices[i] < lowestPrice) {
        previousPrice = lowestPrice
        previousIndex = lowestIndex
        lowestPrice = prices[i]
        lowestIndex = i

        // Check for trend reversal or significant price change
        if (previousIndex >= 0 && (previousPrice - lowestPrice) / previousPrice >= reversalThreshold) {
          isTrendReversal = true
        } else {
          isTrendReversal = false
        }
      }
    }

    return {
      lowest: lowestPrice,
      index: lowestIndex,
      isTrendReversal: isTrendReversal,
    }
  }

  public analyzeTradingSignals(
    psar: number[],
    sma: number[],
    ema: number[],
    macdLine: number[],
    signalLine: number[],
    trendWeight: number,
    fifteenMinuteChart: number[],
    fiveMinuteChart: number[],
    trends: number[],
    oneMinuteChart: number[],
    lastTrade: TxDetail,
  ): TradeAnalysis {
    let trade: TradeAnalysis = {
      tradeSignal: '',
      tradeType: TradingMode.hold,
    }

    let bullishPeriods = 0
    let bearishPeriods = 0
    const priceJumpThreshold = 5 // percentage change
    const priceDropThreshold = 5 // percentage cahnge
    const stopLossThreshold = 1
    const previousPrice = fifteenMinuteChart[fifteenMinuteChart.length - 1]
    const lastPrice = oneMinuteChart[oneMinuteChart.length - 1]
    const percentageChange = ((lastPrice - previousPrice) / previousPrice) * 100
    const FiveMinuteRsi = rsi(fiveMinuteChart)
    const lastFiveMinuteRsi = FiveMinuteRsi[FiveMinuteRsi.length - 1]
    console.log(`Last five minute rsi: ${lastFiveMinuteRsi}`)
    // Last trade
    const lastAction = lastTrade.action
    const lastTradePrice = lastTrade.assetPrice
    const lastBuy = lastAction === 'buy' ? lastTradePrice : undefined
    const lastTradeTime = this.getTimeDifference(new Date(lastTrade.date))
    const lastRsi = this.rsi[this.rsi.length - 1]

    const fiveMinuteChartLastThirty = this.getSma(fiveMinuteChart.slice(-30), 1)
    const FiveMinutedirection = this.determineDirection(
      fiveMinuteChartLastThirty[fiveMinuteChartLastThirty.length - 1],
      fiveMinuteChartLastThirty[fiveMinuteChartLastThirty.length - 2],
    )

    // Confirm trend direction
    const isBullishTrend = psar[psar.length - 1] < sma[sma.length - 1] && psar[psar.length - 1] < ema[ema.length - 1]
    const isBearishTrend = psar[psar.length - 1] > sma[sma.length - 1] && psar[psar.length - 1] > ema[ema.length - 1]

    // Check for MACD crossover signals
    const isBullishCrossover =
      macdLine[macdLine.length - 1] > signalLine[signalLine.length - 1] &&
      macdLine[macdLine.length - 2] < signalLine[signalLine.length - 2]
    const isBearishCrossover =
      macdLine[macdLine.length - 1] < signalLine[signalLine.length - 1] &&
      macdLine[macdLine.length - 2] > signalLine[signalLine.length - 2]

    // Identify support and resistance levels
    const supportLevel = Math.min(sma[sma.length - 1], ema[ema.length - 1])
    const resistanceLevel = Math.max(sma[sma.length - 1], ema[ema.length - 1])

    // trade on the psar
    const isFlashSellSignal = psar.every((value, i) => trends[i] > 0 && value < fifteenMinuteChart[i])
    const isFlashBuySignal = psar.every((value, i) => trends[i] < 0 && value > fifteenMinuteChart[i])

    // Generate trading decision based on the analysis
    if (isBullishTrend) {
      bullishPeriods++
      bearishPeriods = 0
    } else if (isBearishTrend) {
      bearishPeriods++
      bullishPeriods = 0
    }

    const isBullishConditionMet = bullishPeriods >= trendWeight
    const isBearishConditionMet = bearishPeriods >= trendWeight

    switch (lastAction) {
      case 'sell':
        const detectBottom = this.detectBottom(fiveMinuteChart, 0.0001, 30)
        const detectRsiBottom = this.detectBottom(FiveMinuteRsi, 0.01, 6)
        console.log(`Looking for a buy, Support level ${supportLevel}, direction: ${FiveMinutedirection}`)
        console.log(detectBottom, detectRsiBottom)
        if (isBullishConditionMet) {
          trade.tradeSignal = 'Buy: Trend is consistently bullish'
          trade.tradeType = TradingMode.buy
          return trade
        }
        if (isBullishCrossover && percentageChange >= priceJumpThreshold) {
          trade.tradeSignal = 'Buy: PSAR crossed above EMA'
          trade.tradeType = TradingMode.buy
          return trade
        }
        if (isFlashBuySignal) {
          trade.tradeSignal = 'Buy: Flash buy signal'
          trade.tradeType = TradingMode.buy
          return trade
        }
        if (percentageChange <= -priceDropThreshold && lastRsi <= 30) {
          trade.tradeSignal = `Buy: Sudden price drop detected (${percentageChange.toFixed(
            2,
          )}% decrease), Last price: BTC $${lastPrice.toFixed(2)}`
          trade.tradeType = TradingMode.buy
          return trade
        }
        if (
          detectBottom.isTrendReversal &&
          detectRsiBottom.isTrendReversal &&
          +lastTradeTime.timeInMinutes >= 30 &&
          FiveMinutedirection !== 'Downward' &&
          lastRsi <= 50 &&
          lastPrice <= lastTradePrice
        ) {
          trade.tradeSignal = 'buy: Price approaching support level and bottom detected'
          trade.tradeType = TradingMode.buy
          return trade
        } else {
          trade.tradeSignal = 'No clear treading signal'
          console.log(trade.tradeSignal, this.rsi[this.rsi.length - 1])
          return trade
        }
      case 'buy': // last trade was a buy so look for a sell
        const detectTop = this.detectTop(fiveMinuteChart, 0.0001, 30)
        const detectRsiTop = this.detectTop(FiveMinuteRsi, 0.01, 6)
        console.log(`Looking for a Sell, resistance level ${resistanceLevel} direction: ${FiveMinutedirection}`)
        console.log(detectTop, detectRsiTop)
        if (isBearishConditionMet) {
          trade.tradeSignal = 'Sell: Trend is consistently bearish'
          trade.tradeType = TradingMode.sell
          return trade
        }
        if (isBearishCrossover && percentageChange >= -priceDropThreshold) {
          trade.tradeSignal = 'Sell: PSAR crossed below EMA'
          trade.tradeType = TradingMode.sell
          return trade
        }
        if (isFlashSellSignal) {
          trade.tradeSignal = 'Sell: Flash sell signal'
          trade.tradeType = TradingMode.sell
          return trade
        }
        if (percentageChange >= priceJumpThreshold && lastRsi >= 70) {
          trade.tradeSignal = `Sell: Sudden price jump detected (${percentageChange.toFixed(
            2,
          )}% increase), Last price: BTC $${lastPrice.toFixed(2)}`
          trade.tradeType = TradingMode.sell
          return trade
        }
        if (lastBuy && (lastPrice - psar[psar.length - 1]) / psar[psar.length - 1] <= -stopLossThreshold) {
          trade.tradeSignal = `Sell: Stop loss triggered (${stopLossThreshold}% decrease), Last price: BTC $${lastPrice.toFixed(
            2,
          )}`
          trade.tradeType = TradingMode.sell
          return trade
        }
        if (
          detectTop.isTrendReversal &&
          detectRsiTop.isTrendReversal &&
          +lastTradeTime.timeInMinutes >= 30 &&
          FiveMinutedirection !== 'Upward' &&
          lastRsi >= 50 &&
          lastPrice > lastTradePrice
        ) {
          trade.tradeSignal = 'sell: Price approaching resistance level and top detected'
          trade.tradeType = TradingMode.sell
          return trade
        } else {
          trade.tradeSignal = 'No clear treading signal'
          console.log(trade.tradeSignal, this.rsi[this.rsi.length - 1])
          return trade
        }
    }
  }
}
