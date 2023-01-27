

const main = async () => {
    try {
        const bb = require('trading-indicator').bb
        let bbData = await bb(50, 2, "close", "binance", "BTC/USDT", "15m", true)
        console.log(bbData[bbData.length - 2])
        const ema = require('trading-indicator').ema
        let emaData = await ema(8, "close", "binance", "BTC/USDT", "15m", true)
        console.log(emaData[emaData.length - 1])
        const rsi = require('trading-indicator').rsi
        console.log(await rsi(14, "close", "binance", "BTC/USDT", "15m", true))
  
    } catch (err) {
      console.log(err)
    }
  }
  main();