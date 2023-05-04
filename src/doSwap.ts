import { THORChain } from '@xchainjs/xchain-thorchain'
import { ThorchainAMM, TxSubmitted, Wallet } from '@xchainjs/xchain-thorchain-amm'
import {
  CryptoAmount,
  EstimateSwapParams,
  TxDetails,
} from '@xchainjs/xchain-thorchain-query'
import BigNumber from 'bignumber.js'
import {  SwapDetail } from './types'

function printTx(txDetails: TxDetails, input: CryptoAmount) {
  const expanded = {
    memo: txDetails.memo,
    expiry: txDetails.expiry,
    toAddress: txDetails.toAddress,
    txEstimate: {
      input: input.formatedAssetString(),
      totalFees: {
        inboundFee: txDetails.txEstimate.totalFees.inboundFee.formatedAssetString(),
        swapFee: txDetails.txEstimate.totalFees.swapFee.formatedAssetString(),
        outboundFee: txDetails.txEstimate.totalFees.outboundFee.formatedAssetString(),
        affiliateFee: txDetails.txEstimate.totalFees.affiliateFee.formatedAssetString(),
      },
      slipPercentage: txDetails.txEstimate.slipPercentage.toFixed(),
      netOutput: txDetails.txEstimate.netOutput.formatedAssetString(),
      waitTimeSeconds: txDetails.txEstimate.waitTimeSeconds.toFixed(),
      canSwap: txDetails.txEstimate.canSwap,
      errors: txDetails.txEstimate.errors,
    },
  }
  console.log(expanded)
}

/**
 * From asset to asset with no Affiliate address on testnet
 */
export const doSingleSwap = async (tcAmm: ThorchainAMM, wallet: Wallet, swapDetail: SwapDetail): Promise<TxSubmitted> =>{ 
  try {
    const fromAsset = swapDetail.fromAsset
    const toAsset = swapDetail.destinationAsset

    const toChain = toAsset.synth ? THORChain : toAsset.chain
    const destinationAddress = wallet.clients[toChain].getAddress()

    console.log(destinationAddress, fromAsset, toAsset )
    console.log(await wallet.clients[THORChain].getBalance(destinationAddress))

    const swapParams: EstimateSwapParams = {
      input: swapDetail.amount,
      destinationAsset: toAsset,
      destinationAddress,
      slipLimit: new BigNumber('0.05'), //optional
    }
    const outPutCanSwap = await tcAmm.estimateSwap(swapParams)
    printTx(outPutCanSwap, swapParams.input)
    if (outPutCanSwap.txEstimate.canSwap) {
      const output = await tcAmm.doSwap(wallet, swapParams)
      
      console.log(`Tx hash: ${output.hash},\n Tx url: ${output.url}\n WaitTime: ${output.waitTimeSeconds}`)
      return output
    }

  } catch (error) {
    console.error(error)
  }
}
