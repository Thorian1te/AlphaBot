import { ThorchainAMM, TxSubmitted } from '@xchainjs/xchain-thorchain-amm'
import { QuoteSwapParams, TxDetails } from '@xchainjs/xchain-thorchain-query'
import { assetToString, CryptoAmount } from '@xchainjs/xchain-util'
import { Wallet } from '@xchainjs/xchain-wallet'

import { SwapDetail } from './types'

function printTx(txDetails: TxDetails, input: CryptoAmount) {
  const expanded = {
    memo: txDetails.memo,
    expiry: txDetails.expiry,
    toAddress: txDetails.toAddress,
    txEstimate: {
      input: input.formatedAssetString(),
      totalFees: {
        asset: assetToString(txDetails.txEstimate.totalFees.asset),
        outboundFee: txDetails.txEstimate.totalFees.outboundFee.formatedAssetString(),
        affiliateFee: txDetails.txEstimate.totalFees.affiliateFee.formatedAssetString(),
      },
      slipBasisPoints: txDetails.txEstimate.slipBasisPoints.toFixed(),
      netOutput: txDetails.txEstimate.netOutput.formatedAssetString(),
      outboundDelaySeconds: txDetails.txEstimate.outboundDelaySeconds,
      canSwap: txDetails.txEstimate.canSwap,
      errors: txDetails.txEstimate.errors,
    },
  }
  console.log(expanded)
}

/**
 * From asset to asset with no Affiliate address on testnet
 */
export const doSingleSwap = async (
  tcAmm: ThorchainAMM,
  wallet: Wallet,
  swapDetail: SwapDetail,
): Promise<TxSubmitted> => {
  try {
    const fromAsset = swapDetail.fromAsset
    const toAsset = swapDetail.destinationAsset

    // TODO: Thorianite Review
    const toChain = toAsset.chain
    const destinationAddress = await wallet.getAddress(toChain)

    console.log(destinationAddress, fromAsset, toAsset)
    console.log(await wallet.getBalance(toChain))

    const swapParams: QuoteSwapParams = {
      fromAsset: swapDetail.fromAsset,
      amount: swapDetail.amount,
      destinationAsset: toAsset,
      destinationAddress,
      toleranceBps: 5, //optional
    }
    const outPutCanSwap = await tcAmm.estimateSwap(swapParams)
    printTx(outPutCanSwap, swapParams.amount)
    if (outPutCanSwap.txEstimate.canSwap) {
      const output = await tcAmm.doSwap(swapParams)

      console.log(`Tx hash: ${output.hash},\n Tx url: ${output.url}\n`)
      return output
    }
  } catch (error) {
    console.error(error)
  }
}
