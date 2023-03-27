
import { Network } from "@xchainjs/xchain-client"
import { delay } from "@xchainjs/xchain-util"
import { AlphaBot } from "./alphaBot"
import { ChartInterval } from "./types"


const keystore1FilePath = './alphaBot.txt'
const password = process.env.ALPHABOT ?? ''
const pauseTimeSeconds = 10

 
const alphaBot = new AlphaBot(
  Network.Mainnet, keystore1FilePath, password, pauseTimeSeconds 
)

async function main() {
  let start = true
  alphaBot.dataCollectionMinute(start, ChartInterval.OneMinute)
  alphaBot.dataCollectionFiveMinutes(start, ChartInterval.FiveMinute)
  alphaBot.dataCollectionFifteenMinutes(start, ChartInterval.FifteenMinute)
  alphaBot.dataCollectionHalfHour(start, ChartInterval.HalfHour)
  alphaBot.dataCollectionOneHour(start, ChartInterval.OneHour)

  await alphaBot.start() 
}


main()
.then(() => process.exit(0))
.catch((err) => console.error(err))