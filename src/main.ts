import { Network } from "@xchainjs/xchain-client";
import { AlphaBot } from "./alphaBot";
import { ChartInterval, TradingMode } from "./types";


require("dotenv").config();

const keystore1FilePath = "./alphaBot.txt";
const password = process.env.ALPHABOT ?? "";
const pauseTimeSeconds = 10;

const alphaBot = new AlphaBot(
  Network.Mainnet,
  keystore1FilePath,
  password,
  pauseTimeSeconds
);



async function main() {
  let start = true
  alphaBot.dataCollectionMinute(start, ChartInterval.OneMinute);
  alphaBot.dataCollectionFiveMinutes(start, ChartInterval.FiveMinute);
  alphaBot.dataCollectionFifteenMinutes(start, ChartInterval.FifteenMinute);
  alphaBot.dataCollectionHalfHour(start, ChartInterval.HalfHour);
  alphaBot.dataCollectionOneHour(start, ChartInterval.OneHour);
  await alphaBot.start(ChartInterval.FifteenMinute, start);
  // Add any necessary logic or actions within the while loop

}

main()
  .then(() => process.exit(0))
  .catch((err) => console.error(err))
