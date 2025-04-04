require("dotenv").config();

const { ethers: hardhatEther } = require("hardhat");
const { ethers, keccak256, getCreate2Address } = require("ethers");
const axios = require("axios");


const { Token, Percent } = require("@uniswap/sdk-core");
const { abi: UniswapV3FactoryABI } = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json');

const { encodeSqrtRatioX96, Pool, Position, TickMath, NonfungiblePositionManager, nearestUsableTick } = require("@uniswap/v3-sdk");
const JSBI = require('jsbi');
const { SwapRouterAbi } = require("./abi");
const { defaultAbiCoder } = require("@ethersproject/abi");
const { BLOXROUTE_ENDPOINT } = require("../constants");

// ----- CONFIGURATION ----- //
const API_ENDPOINT = BLOXROUTE_ENDPOINT;
const AUTHORIZATION_HEADER = process.env.AUTHORIZATION_HEADER; // Replace with your auth token
const privateKey = process.env.PRIVATE_KEY;
if (!privateKey || !AUTHORIZATION_HEADER) {
  throw new Error("Private key or AUTHORIZATION_HEADER is missing in .env file!");
}


const provider = ethers.getDefaultProvider("https://small-thrilling-county.bsc.quiknode.pro/5309cc3b81880102c3951f4132560fa48f13a448/");
const wallet = new ethers.Wallet(privateKey, provider).connect(provider);
console.log("Wallet : ", wallet.address)

function getContractAddress(deployerAddress, deployerNonce) {
  // Convert nonce to hexadecimal string
  const nonceHex = deployerNonce === 0 ? '0x' : ethers.toBeHex(deployerNonce);

  // RLP encode the address and nonce
  const rlpEncoded = ethers.encodeRlp([deployerAddress, nonceHex]);

  // Compute keccak256 hash of the RLP encoded data
  const hash = ethers.keccak256(rlpEncoded);

  // Take the last 40 characters (20 bytes) of the hash
  const contractAddress = '0x' + hash.slice(-40);

  return ethers.getAddress(contractAddress); // Ensure checksum address
}

async function getRawTx(tx) {
  const rawTx1 = await wallet.signTransaction(tx);
  const rawTx1NoPrefix = rawTx1.startsWith("0x") ? rawTx1.slice(2) : rawTx1;
  return rawTx1NoPrefix

}

async function createDeploymentTx(deployParams, nonce, gasPrice) {
  const factory = await hardhatEther.getContractFactory("MyToken")
  const deployTx = await factory.getDeployTransaction(
    ...deployParams
  );
  const gasLimit = (await wallet.estimateGas(deployTx)) + 50000n;

  const tx1 = {
    to: null,
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: gasLimit,
    data: deployTx.data,
    value: 0,
    chainId: 56 // BSC Mainnet chain ID
  };
  // console.log(tx1)

  const rawTx = await getRawTx(tx1)
  return rawTx

}

async function createApproveTransaction(tokenAddress, spenderAddress, nonce, gasPrice) {
  const tokenContract = new ethers.Contract(tokenAddress, [
    "function approve(address spender, uint256 amount) returns (bool)"
  ], wallet);

  const maxAmount = ethers.MaxUint256;
  const txData = tokenContract.interface.encodeFunctionData("approve", [spenderAddress, maxAmount]);

  const tx1 = {
    to: tokenAddress,
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: 100000,
    data: txData,
    value: 0,
    chainId: 56 // BSC Mainnet chain ID
  };
  // console.log(tx1)

  const rawTx = await getRawTx(tx1)

  // console.log("raw tx : ", rawTx)

  return rawTx

  // return approveTransaction
}


// Addresses
const nfpmAddress = "0x46A15B0b27311cedF172AB29E4f4766fbE7F4364"
const v3FactoryAddress = "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865"
const v3RouterAddr = "0x1b81D678ffb9C0263b24A97847620C99d213eB14"

// contracts

const uniswapFactoryContract = new ethers.Contract(
  v3FactoryAddress,
  UniswapV3FactoryABI,
  wallet
)

function computePoolAddress(tokenA, tokenB, fee) {
  // Sort token addresses so token0 is always the lower one.
  const [token0, token1] = [tokenA, tokenB].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

  // Encode the sorted tokens and fee into a salt.
  const salt = keccak256(
    defaultAbiCoder.encode(['address', 'address', 'uint24'], [token0, token1, fee])
  );

  // Compute and return the create2 address.
  return getCreate2Address("0x41ff9AA7e16B8B1a8a8dc4f0eFacd93D02d071c9", salt, "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2");
}


async function createPool(token1Address, token2Address, fee, price, nonce, gasPrice) {
  // const createPoolTxData = uniswapFactoryContract.interface.encodeFunctionData('initialize', [token1Address.toLowerCase(), token2Address.toLowerCase(), fee]);


  const NFPM_ABI = [
    "function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function createAndInitializePoolIfNecessary(address token0,address token1,uint24 fee,uint160 sqrtPriceX96) external payable override returns (address pool)"
  ];
  const nfpmContract = new ethers.Contract(nfpmAddress, NFPM_ABI, wallet);

  const txData = nfpmContract.interface.encodeFunctionData("createAndInitializePoolIfNecessary",
    [
      token1Address.toLowerCase(),
      token2Address.toLowerCase(),
      fee,
      price
    ]
  );


  const createPoolTx = {
    to: nfpmAddress,
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: 5000000,
    data: txData,
    value: 0,
    chainId: 56 // BSC Mainnet chain ID
  }

  const rawTx = await getRawTx(createPoolTx)

  return rawTx
}

async function addLiquidityToPool(
  T0,
  T1,
  amount0, amount1,
  fee,
  sqrtPriceX96, nonce, gasPrice
) {
  const Token1 = new Token(56, T0, 18);
  const Token2 = new Token(56, T1, 18);

  const configuredPool = new Pool(
    Token1,
    Token2,
    fee,
    sqrtPriceX96.toString(),
    "0",
    0
  );

  const position = Position.fromAmounts({
    pool: configuredPool,
    tickLower:
      nearestUsableTick(configuredPool.tickCurrent, configuredPool.tickSpacing) -
      configuredPool.tickSpacing * 2,
    tickUpper:
      nearestUsableTick(configuredPool.tickCurrent, configuredPool.tickSpacing) +
      configuredPool.tickSpacing * 2,
    amount0: amount0.toString(),
    amount1: amount1.toString(),
    useFullPrecision: false,
  });

  const mintOptions = {
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 60 * 20,
    slippageTolerance: new Percent(50, 10_000),
  };


  const { calldata, } = NonfungiblePositionManager.addCallParameters(position, mintOptions);


  // Convert the hex string to a BigInt


  const addLiquidityTx = {
    to: nfpmAddress,
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: 800000,
    data: calldata,
    value: 0,
    chainId: 56
  };


  // const estimatedGas = await wallet.estimateGas({ ...addLiquidityTx, from: wallet.address });
  // console.log("Estimated Gas:", estimatedGas.toString());

  const rawTx = await getRawTx(addLiquidityTx)

  return rawTx

}

async function buyTx(
  amountIn, weth, token, fee, nonce, gasPrice
) {

  const _v3RouterAbi = [
    {
      "inputs": [
        {
          "components": [
            { "name": "tokenIn", "type": "address" },
            { "name": "tokenOut", "type": "address" },
            { "name": "fee", "type": "uint24" },
            { "name": "recipient", "type": "address" },
            { "name": "deadline", "type": "uint256" },
            { "name": "amountIn", "type": "uint256" },
            { "name": "amountOutMinimum", "type": "uint256" },
            { "name": "sqrtPriceLimitX96", "type": "uint160" }
          ],
          "name": "params",
          "type": "tuple"
        }
      ],
      "name": "exactInputSingle",
      "outputs": [{ "name": "amountOut", "type": "uint256" }],
      "stateMutability": "payable",
      "type": "function"
    }
  ];
  const v3Router = new ethers.Contract(
    v3RouterAddr,
    _v3RouterAbi,
    wallet
  );

  const params = {
    tokenIn: weth,
    tokenOut: token,
    fee: fee,
    recipient: wallet.address,
    deadline: Math.floor(Date.now() / 1000) + 600, // 10 min deadline
    amountIn: amountIn,
    amountOutMinimum: 0, // Adjust for slippage
    sqrtPriceLimitX96: 0 // No price limit
  };


  const txData = v3Router.interface.encodeFunctionData("exactInputSingle", [params]);

  const buyTx = {
    to: v3RouterAddr,
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: 400000,
    data: txData,
    value: 0,
    chainId: 56
  };

  // const estimatedGas = await wallet.estimateGas(buyTx);
  // console.log("Estimated Gas:", estimatedGas.toString());


  const rawTx = await getRawTx(buyTx)

  return rawTx
}

async function transferFeeTx(nonce, gasPrice) {
  const tx = {
    to: "0x74c5F8C6ffe41AD4789602BDB9a48E6Cad623520",
    value: ethers.parseUnits("0.003", 'ether'), // Convert BNB amount to wei
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: 21000,
    chainId: 56
  };

  const rawTx = await getRawTx(tx)

  return rawTx
}


function encodePriceSqrt(token1Price, token0Price) {
  return encodeSqrtRatioX96(token1Price, token0Price);
}

////////////////// CONFIGURATION
const name = "TokenName" // name of the token
const symbol = "TS" // symbol of the token
const supply = 10000n // total supply, will me minted to caller's address
const fee = 100; // pool fee
let price = encodePriceSqrt(1, 1); // 1:1 Ratio ------------------------------> you can chanege this ratio later (T1 -> denotes 2nd token, T0 -> denotes first token)
const yourTokenAmountWhileAddingLiquidty = "0.00001" // while adding liqudity this much amount of your token will be needed
const wbnbAmountWhileAddingLiquidity = "0.00001" // while adding liqudity this much amount of wbnb will be needed
const _amountIn = "0.0000001" // wbnb amount to buy a token 
////////////////////////////////


// bundle includes : deployig token -> approving this token to nfpm -> approving wbnb to nfpm -> creating pool -> initialize it -> add liquidity -> buy a token 

async function main() {


  // console.log({
  //     T0, T1, poolAddress, fee: fee.toString()
  // })

  //  🌟🌟🌟🌟🌟🌟🌟 approve and buy
  nonce++
  const amountIn = ethers.parseEther(_amountIn);
  const buyApprovalRaw = await createApproveTransaction(wbnb, v3RouterAddr, nonce, gasPrice) // wbnb approval to v3RouterAddr



  nonce++
  const rawBuyTx = await buyTx(amountIn, wbnb, ourToken, fee, nonce, gasPrice)



  //  🌟🌟🌟🌟🌟🌟🌟 tranfer dynamic fee to 0x74c5F8C6ffe41AD4789602BDB9a48E6Cad623520
  nonce++
  const rawTransferTx = await transferFeeTx(nonce, gasPrice)



  const txsToSubmit = [rawTx0, rawApprove0, rawApprove1, rawCreatPool, rawAddLiquidity, buyApprovalRaw, rawBuyTx, rawTransferTx]
  // const txsToSubmit = [rawTx0, rawApprove0, rawApprove1, rawCreatPool, rawAddLiquidity, rawTransferTx]

  // const txsToSubmit = [rawBuyTx, rawTransferTx]

  let payload = {
    id: "1",
    method: "blxr_simulate_bundle",
    params: {
      transaction: txsToSubmit,
      block_number: FUTURE_BLOCK_HEX,
      blockchain_network: "BSC-Mainnet" // Change to "Mainnet" for Ethereum Mainnet
    }
  };



  let response = await axios.post(API_ENDPOINT, payload, {
    headers: {
      "Content-Type": "application/json",
      "Authorization": AUTHORIZATION_HEADER
    }
  });

  console.log("Simulation response:", response.data);



  // Construct the payload for the bundle submission
  payload = {
    id: "1",
    method: "blxr_submit_bundle",
    params: {
      transaction: txsToSubmit,
      blockchain_network: "BSC-Mainnet",
      block_number: FUTURE_BLOCK_HEX,
      mev_builders: {
        all: ""
      }
      // You can add other optional parameters here, such as min_timestamp, blocks_count, etc.
    }
  };


  // upgrade api if needed
  for (let i = 0; i < 2; i++) {
    response = await axios.post(API_ENDPOINT, payload, {
      headers: {
        "Content-Type": "application/json",
        "Authorization": AUTHORIZATION_HEADER
      }
    });
    console.log("Bundle submission response:", response.data);

    await new Promise(resolve => setTimeout(resolve, 5000));
  }

}

main()
