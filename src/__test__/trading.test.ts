import { TradingDecision } from "../tradingIndicators"

const trading = new TradingDecision()

describe('decision Test', () => {

  it(`Should check class`, async () => {
    const bb =  await trading.bolingerBands()
    console.log(bb)

  })

 })
