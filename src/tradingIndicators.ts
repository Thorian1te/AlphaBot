


export class TradingDecision {

    public async bolingerBands(): Promise<string> {
        const ema = require('trading-indicator').ema
        let emaData = await ema(8, "close", "binance", "BTC/USDT", "15m", true)
        return emaData 
    }


}