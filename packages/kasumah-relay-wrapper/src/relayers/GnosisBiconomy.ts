import { OPERATION, WalletMaker } from "kasumah-wallet";
import { GnosisSafe__factory } from "kasumah-wallet/dist/types/ethers-contracts/factories/GnosisSafe__factory";
import { Signer, Contract, VoidSigner, constants, providers, PopulatedTransaction, ContractTransaction } from "ethers";
import { Relayer } from "./types";
import { multisendTx, MULTI_SEND_ADDR, safeFromPopulated, safeTx } from "./GnosisHelpers";
import { GnosisSafe } from "kasumah-wallet/dist/types/ethers-contracts/GnosisSafe";
import axios, { AxiosStatic } from 'axios';
import debug from 'debug'
import { exec } from "child_process";

const log = debug('GnosisBiconomy')

interface GnosisBiconomyRelayerConstrutorArgs {
  userSigner: Signer; // used to sign the gasless txs
  targetChainProvider: providers.Provider;
  chainId: number;
  apiKey: string;
  apiId: string;
  httpClient?: AxiosStatic
}

export class GnosisBiconomy implements Relayer {
  userSigner: Signer; // the signer used to sign transactions
  walletMaker: WalletMaker;
  safeFactory: GnosisSafe__factory;
  targetChainProvider: providers.Provider;

  apiId: string;
  apiKey: string;

  private voidSigner: VoidSigner;
  private httpClient: AxiosStatic

  constructor({
    userSigner,
    chainId,
    apiKey,
    apiId,
    targetChainProvider,
    httpClient,
  }: GnosisBiconomyRelayerConstrutorArgs) {
    this.userSigner = userSigner;
    this.voidSigner = new VoidSigner(constants.AddressZero, targetChainProvider);
    this.walletMaker = new WalletMaker({ signer: this.voidSigner, chainId });
    this.safeFactory = new GnosisSafe__factory(this.voidSigner);
    this.targetChainProvider = targetChainProvider;
    this.apiId = apiId;
    this.apiKey = apiKey;

    // useful for testing
    if (httpClient) {
        log('using user-supplied http client')
        this.httpClient = httpClient
    } else {
        this.httpClient = axios
    }
  }

  async multisend(txs:PopulatedTransaction[]):Promise<ContractTransaction> {
    const multiTx = await multisendTx(txs)
    const userAddr = await this.userSigner.getAddress();

    const userWalletAddr = await this.walletMaker.walletAddressForUser(
      userAddr
    );

    const safe = this.safeFactory.attach(userWalletAddr);

    const [_,execArgs] = await safeFromPopulated(safe, this.userSigner, userWalletAddr, MULTI_SEND_ADDR, multiTx.data!, OPERATION.DELEGATE_CALL)
    return this.sendSignedTransaction(userWalletAddr, userAddr, execArgs)
  }

  async transmit(to: Contract, funcName: string, ...args: any) {
    const userAddr = await this.userSigner.getAddress();

    const userWalletAddr = await this.walletMaker.walletAddressForUser(
      userAddr
    );
    const safe = this.safeFactory.attach(userWalletAddr);
    log("transmit: userAddr: ", userAddr, " wallet: ", userWalletAddr);

    const [, execArgs] = await safeTx(
      safe,
      this.userSigner,
      userWalletAddr,
      to,
      funcName,
      ...args
    );
    return this.sendSignedTransaction(userWalletAddr, userAddr, execArgs);
  }

  private async sendSignedTransaction(
    walletAddress: string,
    userAddress: string,
    execArgs: Parameters<GnosisSafe["execTransaction"]>
  ) {
    log('transmitting to biconomy')
    try {
      const resp = await this.httpClient.post(
        "https://api.biconomy.io/api/v2/meta-tx/native",
        {
          to: walletAddress,
          apiId: this.apiId,
          params: execArgs,
          from: userAddress,
          gasLimit: 9500000,
        },
        {
          headers: {
            "x-api-key": this.apiKey,
          },
        }
      );
      log('resp: ', resp)
      const tx = await this.voidSigner.provider?.getTransaction(resp.data.txHash)
      return tx!
    } catch (error) {
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.error(error.response.data);
        console.error(error.response.status);
        console.error(error.response.headers);
      } else if (error.request) {
        // The request was made but no response was received
        // `error.request` is an instance of XMLHttpRequest in the browser and an instance of
        // http.ClientRequest in node.js
        console.error(error.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        console.error('Error', error.message);
      }
      throw error
    }
    
  }
}
