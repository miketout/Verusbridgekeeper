const Web3 = require('web3');
const bitGoUTXO = require('bitgo-utxo-lib');
const confFile = require('./confFile.js')
const constants = require('./constants');
const ethersUtils = require('ethers').utils
const { addHexPrefix } = require('./utils');
const util = require('./utils.js');
const notarizationFuncs = require('./notarization.js');
const abi = new Web3().eth.abi
const deserializer = require('./deserializer.js');
const { initApiCache, initBlockCache,  setCachedApi, getCachedApi, checkCachedApi, setCachedApiValue, clearCachedApis, getCachedBlock, setCachedBlock } = require('./cache/apicalls')
const notarization = require('./utilities/notarizationSerializer.js');

// command line arguments
const ticker = process.argv.indexOf('-production') > -1 ? "VRSC" : "VRSCTEST";
const logging = (process.argv.indexOf('-log') > -1);
const debug = (process.argv.indexOf('-debug') > -1);
const debugsubmit = (process.argv.indexOf('-debugsubmit') > -1);
const debugnotarization = (process.argv.indexOf('-debugnotarization') > -1);
const noimports = (process.argv.indexOf('-noimports') > -1);
const CHECKHASH = (process.argv.indexOf('-checkhash') > -1);

//Main coin ID's
const ETHSystemID = constants.VETHCURRENCYID;
const VerusSystemID = constants.VERUSSYSTEMID
const BridgeID = constants.BRIDGEID
const IAddressBaseConst = constants.IAddressBaseConst;
const RAddressBaseConst = constants.RAddressBaseConst;
const maxGas = constants.maxGas;
const verusBridgeMasterAbi = require('./abi/VerusBridgeMaster.json');
const verusNotarizerStorageAbi = require('./abi/VerusNotarizerStorage.json');
const verusUpgradeManagerAbi = require('./abi/VerusUpgradeManager.json');
const verusBridgeStorageAbi = require('./abi/VerusBridgeStorage.json');
const verusNotarizerAbi = require('./abi/VerusNotarizer.json');
const verusSerializerAbi = require('./abi/VerusSerializer.json');

// Global settings
let settings = undefined;
let noaccount = false;
let web3 = undefined;
let d = new Date();
let globalsubmitimports = { "transactionHash": "" };
let globaltimedelta = constants.globaltimedelta; //60s
let globallastinfo = d.valueOf() - globaltimedelta;
let globallastcurrency = d.valueOf() - globaltimedelta;
let globalgetlastimport = d.valueOf() - globaltimedelta;
let verusBridgeMaster = undefined;
let verusNotorizerStorage = undefined;
let verusBridgeStorage = undefined;
let storageAddress = undefined;
let verusNotarizer = undefined;
let verusSerializer = undefined;
let transactioncount = 0;
let account = undefined;
let upgradeManager = undefined;
let contracts = [];

function setupConf() {
    settings = confFile.loadConfFile(ticker);
    web3 = new Web3(new Web3.providers.WebsocketProvider(settings.ethnode, {
        clientConfig: {
            maxReceivedFrameSize: 100000000,
            maxReceivedMessageSize: 100000000,
            keepalive: true,
            keepaliveInterval: -1 // ms
        },
        reconnect: {
            auto: true,
            delay: 5000, // ms
            maxAttempts: 5,
            onTimeout: false,
        }
    }));
    if (settings.privatekey.length == 64) {
        account = web3.eth.accounts.privateKeyToAccount(settings.privatekey);
        web3.eth.accounts.wallet.add(account);
    } else {
        noaccount = true;
    }
    web3.eth.handleRevert = true;
    upgradeManager = new web3.eth.Contract(verusUpgradeManagerAbi, settings.upgrademanageraddress);
}

exports.init = async() => {

    setupConf();
    for (let i = 0; i < 12; i++) {
        let tempContract = await upgradeManager.methods.contracts(i).call();
        contracts.push(tempContract);
    }
    verusBridgeMaster = new web3.eth.Contract(verusBridgeMasterAbi, contracts[constants.CONTRACT_TYPE.VerusBridgeMaster]);
    verusNotorizerStorage = new web3.eth.Contract(verusNotarizerStorageAbi, contracts[constants.CONTRACT_TYPE.VerusNotarizerStorage]);
    verusBridgeStorage = new web3.eth.Contract(verusBridgeStorageAbi, contracts[constants.CONTRACT_TYPE.VerusBridgeStorage]);
    verusNotarizer = new web3.eth.Contract(verusNotarizerAbi, contracts[constants.CONTRACT_TYPE.VerusNotarizer]);
    verusSerializer = new web3.eth.Contract(verusSerializerAbi, contracts[constants.CONTRACT_TYPE.VerusSerializer]);
    storageAddress = contracts[constants.CONTRACT_TYPE.VerusBridgeStorage];

    initApiCache();
    initBlockCache();
    eventListener(contracts[constants.CONTRACT_TYPE.VerusNotarizer]);

};

async function eventListener(notarizerAddress) {

    var options = {
        reconnect: {
            auto: true,
            delay: 5000, // ms
            maxAttempts: 5,
            onTimeout: false
        },
        address: notarizerAddress,
        topics: [
            '0x680ce19d19cb7479bae869cebd27efcca33f6f22a43fd4d52d6c62a64890b7fd'
        ]
    };

    web3.eth.subscribe('logs', options, function(error, result) {
        if (!error) console.log('Notarization at ETH Height: ' +  result?.blockNumber);
        else console.log(error);
    }).on("data", function(log) {
        console.log('***** EVENT: New Notarization, Clearing the cache*********');
        clearCachedApis();
        // await setCachedApi(log?.blockNumber, 'lastNotarizationHeight');
    }).on("changed", function(log) {
        console.log('***** EVENT: New Notarization, Clearing the cache**********');
        clearCachedApis();
    });
}

function amountFromValue(incoming) {
    if (incoming == 0) return 0;
    return (incoming * 100000000).toFixed(0);
}

function serializeCCurrencyValueMap(ccvm) {

    let encodedOutput = Buffer.from(util.removeHexLeader(ccvm.currency), 'hex');
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(amountFromValue(ccvm.amount), 64)]);

    return encodedOutput
}

function serializeCCurrencyValueMapVarInt(ccvm) {

    let encodedOutput = Buffer.from(util.removeHexLeader(ccvm.currency), 'hex');
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(parseInt(ccvm.amount, 10))]);

    return encodedOutput
}

const FLAG_DEST_AUX = 64;

function serializeCTransferDestination(ctd) {

    let encodedOutput = Buffer.alloc(1);
    encodedOutput.writeUInt8(ctd.destinationtype);

    let lengthOfDestination = {};
    let destination = Buffer.from(util.removeHexLeader(ctd.destinationaddress), 'hex');

    if (ctd.destinationtype == constants.DEST_REGISTERCURRENCY) {

        lengthOfDestination = Buffer.byteLength(destination);
    } else {

        lengthOfDestination = constants.UINT160_LENGTH;

    }

    encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(lengthOfDestination), destination]);

    if (parseInt(ctd.destinationtype & FLAG_DEST_AUX) == FLAG_DEST_AUX)
    {
        let mainVecLength = ctd.auxdests.length;

        let subLength = util.writeCompactSize(mainVecLength);

        let subvector = Buffer.from("");

        for (let i = 0; i < mainVecLength; i++)
        {
            let subType = Buffer.alloc(1);
            subType.writeUInt8(ctd.auxdests[i].type);
            let subDestination = Buffer.from(bitGoUTXO.address.fromBase58Check(ctd.auxdests[i].address, 160).hash);

            let arrayItem = Buffer.concat([subType, util.writeCompactSize(Buffer.byteLength(subDestination)), subDestination])
            subvector = Buffer.concat([subvector, util.writeCompactSize(Buffer.byteLength(arrayItem)), arrayItem])

        }

        encodedOutput = Buffer.concat([encodedOutput, subLength, subvector]);

    }

    return encodedOutput;
}



function serializeCrossChainExport(cce) {

    let encodedOutput = util.writeUInt(cce.version, 16);
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.flags, 16)]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.sourcesystemid, 160).hash]);
    //hashtransfers uint256
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(cce.hashtransfers), 'hex')]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.destinationsystemid, 160).hash]);
    encodedOutput = Buffer.concat([encodedOutput, bitGoUTXO.address.fromBase58Check(cce.destinationcurrencyid, 160).hash]);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from('0000', 'hex')]); //exporter set to type 00 and address length 00
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.firstinput, 32)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(cce.numinputs, 32)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(cce.sourceheightstart)]);
    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(cce.sourceheightend)]);
    //totalfees CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.serializeCCurrencyValueMapArray(cce.totalfees)]);
    //totalamounts CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.serializeCCurrencyValueMapArray(cce.totalamounts)]);
    //totalburned CCurrencyValueMap
    encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(1), serializeCCurrencyValueMap(cce.totalburned[0])]); //fees always blank value map 0
    //CTransfer DEstionation for Reward Address
    
    let reserveTransfers = Buffer.alloc(1);
    reserveTransfers.writeUInt8(0); //empty reserve transfers

    encodedOutput = Buffer.concat([encodedOutput, reserveTransfers]);

    return encodedOutput;
}

function serializeCReserveTransfers(crts) {

    let encodedOutput = Buffer.from(''); 
    for (let i = 0; i < crts.length; i++) {
        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].version)]); // should be 1 for single transfer
        if (crts[i].currencyvalue)
            encodedOutput = Buffer.concat([encodedOutput, serializeCCurrencyValueMapVarInt(crts[i].currencyvalue)]); // TODO: [EB-2] Varint instead of uint64
        else
            encodedOutput = Buffer.concat([encodedOutput, serializeCCurrencyValueMapVarInt(crts[i].currencyvalues)]);

        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].flags)]);
        encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].feecurrencyid), 'hex')]);
        encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(crts[i].fees)]);
        encodedOutput = Buffer.concat([encodedOutput, serializeCTransferDestination(crts[i].destination)]);
        if (crts[i].destcurrencyid)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destcurrencyid), 'hex')]);
        else
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destinationcurrencyid), 'hex')]);
        if ((crts[i].flags & constants.RESERVE_TO_RESERVE) == constants.RESERVE_TO_RESERVE)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].secondreserveid), 'hex')]);

        if ((crts[i].flags & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM && crts[i].destsystemid)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].destsystemid), 'hex')]);
        else if ((crts[i].flags & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM && crts[i].exportto)
            encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(crts[i].exportto), 'hex')]);

    }

    return encodedOutput; 
}

//takes in an array of proof strings and serializes
function serializeEthProof(proofArray) {
    if (proofArray === undefined) return null;
    let encodedOutput = util.writeVarInt(proofArray.length);
    //loop through the array and add each string length and the string
    //serialize account proof
    for (let i = 0; i < proofArray.length; i++) {
        //remove the 0x at the start of the string
        let proofElement = util.removeHexLeader(proofArray[i]);
        encodedOutput = Buffer.concat([encodedOutput, util.writeCompactSize(proofElement.length / 2)]);
        encodedOutput = Buffer.concat([encodedOutput, Buffer.from(proofElement, 'hex')]);
    }
    return encodedOutput;
}

function serializeEthFullProof(ethProof) {
    let encodedOutput = Buffer.alloc(1);
    let version = 1;
    encodedOutput.writeUInt8(version);

    let type = constants.TRANSFER_TYPE_ETH; 
    let typeBuffer = Buffer.alloc(1);
    typeBuffer.writeUInt8(type);
    encodedOutput = Buffer.concat([encodedOutput, typeBuffer]);

    //write accountProof length
    let sizeBuffer = Buffer.alloc(4);
    sizeBuffer.writeUInt32LE(1);
    encodedOutput = Buffer.concat([encodedOutput, sizeBuffer]);

    let branchTypeBuffer = Buffer.alloc(1);
    branchTypeBuffer.writeUInt8(4); //eth branch type
    encodedOutput = Buffer.concat([encodedOutput, branchTypeBuffer]);
    //merkle branch base
    encodedOutput = Buffer.concat([encodedOutput, branchTypeBuffer]);

    //serialize account proof
    encodedOutput = Buffer.concat([encodedOutput, serializeEthProof(ethProof.accountProof)]);
    //serialize address bytes 20
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.address), 'hex')]);
    let balancehex = util.removeHexLeader(web3.utils.numberToHex(ethProof.balance));
    let temphexreversed = web3.utils.padLeft(balancehex, 64).match(/[a-fA-F0-9]{2}/g).reverse().join('');
    let tempbuf = Buffer.from(temphexreversed, 'hex');
    encodedOutput = Buffer.concat([encodedOutput, tempbuf]);

    //serialize codehash bytes 32
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.codeHash), 'hex')]);
    //serialize nonce as uint32

    encodedOutput = Buffer.concat([encodedOutput, util.writeVarInt(ethProof.nonce)]);
    //serialize storageHash bytes 32
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(util.removeHexLeader(ethProof.storageHash), 'hex')]);

    //loop through storage proofs
    let key = util.removeHexLeader(ethProof.storageProof[0].key);
    key = web3.utils.padLeft(key, 64);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from(key, 'hex')]);
    encodedOutput = Buffer.concat([encodedOutput, serializeEthProof(ethProof.storageProof[0].proof)]);
    return encodedOutput;
}

async function getProof(eIndex, blockHeight) {
    let index = "0000000000000000000000000000000000000000000000000000000000000000";

    let position = Buffer.alloc(4);
    position.writeUInt32BE(eIndex);
    let posString = position.toString('hex');
    posString = web3.utils.padLeft(posString, 64);

    let key = web3.utils.sha3("0x" + posString + index, { "encoding": "hex" });

    try {

        let proof = await web3.eth.getProof(storageAddress, [key], blockHeight);
        return proof;
    } catch (error) {
        console.log("error:", error);
        return { status: false, error: error };
    }
}

// create the component parts for the proof

function createComponents(transfers, blockHeight, previousExportHash, poolavailable) {

    let cce = createCrossChainExport(transfers, blockHeight, false, poolavailable);
    //Var Int Components size as this can only 
    let encodedOutput = util.writeCompactSize(1);
    //eltype
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(7, 16)]);
    //elIdx
    encodedOutput = Buffer.concat([encodedOutput, util.writeUInt(0, 16)]);
    //elVchObj
    let exportKey = constants.VDXFDATAKEY[ticker];
    let serializedVDXF = Buffer.from(exportKey, 'hex');
    let version = 1;
    serializedVDXF = Buffer.concat([serializedVDXF, util.writeUInt(version, 1)]);

    let serialized = Buffer.from(serializeCrossChainExport(cce));

    let prevhash = Buffer.from(util.removeHexLeader(previousExportHash), 'hex');

    serialized = Buffer.concat([serialized, prevhash]);

    if (CHECKHASH) {
        let hashofcce_reserves = ethersUtils.keccak256(serialized);
        let serialization = Buffer.concat([serializeCrossChainExport(cce),serializeCReserveTransfers(transfers).slice(1)]);
        console.log("Hash of cce+reservet: \n", hashofcce_reserves.toString('hex'));
        console.log("serialization of ccx + prevhash: \n", serialization.toString('hex'));
    }

    serialized = Buffer.concat([util.writeCompactSize(serialized.length), serialized]);

    serialized = Buffer.concat([serializedVDXF, serialized]);

    serialized = Buffer.concat([util.writeCompactSize(serialized.length), serialized]);

    encodedOutput = Buffer.concat([encodedOutput, serialized]);
    encodedOutput = Buffer.concat([encodedOutput, Buffer.from('00000000', 'hex')]); //no elproof
    return encodedOutput.toString('Hex');

}
//create an outbound trans
function createOutboundTransfers(transfers) {
    let outTransfers = [];
    for (let i = 0; i < transfers.length; i++) {
        let transfer = transfers[i];
        let outTransfer = {};
        outTransfer.version = 1;
        outTransfer.currencyvalues = {
            [util.ethAddressToVAddress(transfer.currencyvalue.currency, IAddressBaseConst)]: util.uint64ToVerusFloat(transfer.currencyvalue.amount)
        };
        outTransfer.flags = transfer.flags;
        if ((parseInt(outTransfer.flags) & constants.CROSS_SYSTEM) == constants.CROSS_SYSTEM) {
            outTransfer.exportto = util.ethAddressToVAddress(transfer.destsystemid, IAddressBaseConst);
        }
        outTransfer.feecurrencyid = util.ethAddressToVAddress(transfer.feecurrencyid, IAddressBaseConst);
        outTransfer.fees = util.uint64ToVerusFloat(transfer.fees);

        if ((parseInt(transfer.flags) & constants.RESERVETORESERVE) == constants.RESERVETORESERVE) { 
            outTransfer.destinationcurrencyid = util.ethAddressToVAddress(transfer.secondreserveid, IAddressBaseConst);
            outTransfer.via = util.ethAddressToVAddress(transfer.destcurrencyid, IAddressBaseConst);
        } else {
            outTransfer.destinationcurrencyid = util.ethAddressToVAddress(transfer.destcurrencyid, IAddressBaseConst);
        }

        let address = {};

        address = util.hexAddressToBase58(transfer.destination.destinationtype, transfer.destination.destinationaddress.slice(0, 42));

        if (transfer.destination.destinationaddress.length > 42)
            outTransfer.destination = {
            "type": transfer.destination.destinationtype,
            "address": address,
            "gateway": util.ethAddressToVAddress(transfer.destination.destinationaddress.slice(42, 82), IAddressBaseConst),
            "fees": parseInt(transfer.destination.destinationaddress.slice(transfer.destination.destinationaddress.length - 16, transfer.destination.destinationaddress.length - 1).match(/[a-fA-F0-9]{2}/g).reverse().join(''), 16) / 100000000
        }
        else{
            outTransfer.destination = {
                "type": transfer.destination.destinationtype,
                "address": address
            }
        }

        outTransfers.push(outTransfer);
    }
    return outTransfers;
}

function createCrossChainExport(transfers, blockHeight, jsonready = false, poolavailable) {
    let cce = {};
    let hash = ethersUtils.keccak256(serializeCReserveTransfers(transfers));
    if (CHECKHASH) {
        console.log("hash of transfers: ",hash.toString('Hex'));
        console.log("Serialize: ",serializeCReserveTransfers(transfers).slice(1).toString('Hex'));
    }
    cce.version = 1;
    cce.flags = 2;
    cce.sourcesystemid = ETHSystemID;
    cce.hashtransfers = hash;
    cce.destinationsystemid = VerusSystemID;

    if (poolavailable) {
        cce.destinationcurrencyid = BridgeID;
    } else {
        cce.destinationcurrencyid = VerusSystemID;
    }

    cce.sourceheightstart = blockHeight;
    cce.sourceheightend = blockHeight;
    cce.numinputs = transfers.length;
    cce.totalamounts = [];
    let totalamounts = [];
    cce.totalfees = [];
    let totalfees = [];
    for (let i = 0; i < transfers.length; i++) {
        //sum up all the currencies 
        if (util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst) in totalamounts)
            totalamounts[util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst)] += parseInt(transfers[i].currencyvalue.amount);
        else
            totalamounts[util.uint160ToVAddress(transfers[i].currencyvalue.currency, IAddressBaseConst)] = parseInt(transfers[i].currencyvalue.amount);
        //add fees to the total amounts
        if (util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst) in totalamounts)
            totalamounts[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] += parseInt(transfers[i].fees);
        else
            totalamounts[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] = parseInt(transfers[i].fees);


        if (util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst) in totalfees)
            totalfees[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] += parseInt(transfers[i].fees);
        else
            totalfees[util.uint160ToVAddress(transfers[i].feecurrencyid, IAddressBaseConst)] = parseInt(transfers[i].fees);
    }
    for (let key in totalamounts) {
        cce.totalamounts.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalamounts[key]) : totalamounts[key]) });
    }
    for (let key in totalfees) {
        cce.totalfees.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalfees[key]) : totalfees[key]) });
    }

    cce.totalburned = [{ "currency": '0x0000000000000000000000000000000000000000', "amount": 0 }]; // serialiser doesnt like empty strings or non BIgints
    cce.rewardaddress = ""; //  blank
    cce.firstinput = 1;
    if (debugsubmit) {
        console.log(JSON.stringify(cce.totalamounts),null,2);
        console.log("cce", JSON.stringify(cce),null,2);
    }
    return cce;
}

function createCrossChainExportToETH(transfers, blockHeight, jsonready = false) {
    let cce = {};
    let hash = ethersUtils.keccak256(serializeCReserveTransfers(transfers));
    if (CHECKHASH) {
        console.log("hash of transfers: ",hash.toString('Hex'));
        console.log("Serialize: ",serializeCReserveTransfers(transfers).slice(1).toString('Hex'));
    }
    cce.version = 1;
    cce.flags = 2;
    cce.sourcesystemid = util.convertVerusAddressToEthAddress(ETHSystemID);
    cce.hashtransfers = addHexPrefix(hash);
    cce.destinationsystemid = util.convertVerusAddressToEthAddress(VerusSystemID);

    if (transfers[0].destcurrencyid.slice(0, 2) == "0x" && transfers[0].destcurrencyid.length == 42) {
        cce.destinationcurrencyid = transfers[0].destcurrencyid;
    } else {
        cce.destinationcurrencyid = util.convertVerusAddressToEthAddress(transfers[0].destcurrencyid);
    }

    cce.sourceheightstart = 1;
    cce.sourceheightend = 2;

    cce.numinputs = transfers.length;
    cce.totalamounts = [];
    let totalamounts = [];
    cce.totalfees = [];
    let totalfees = [];

    for (let i = 0; i < transfers.length; i++) {
        //sum up all the currencies
        if (transfers[i].currencyvalue.currency in totalamounts)
            totalamounts[transfers[i].currencyvalue.currency] += transfers[i].currencyvalue.amount;
        else
            totalamounts[transfers[i].currencyvalue.currency] = transfers[i].currencyvalue.amount;
        //add fees to the total amounts
        if (transfers[i].feecurrencyid in totalamounts)
            totalamounts[transfers[i].feecurrencyid] += transfers[i].fees;
        else
            totalamounts[transfers[i].feecurrencyid] = transfers[i].fees;

        if (transfers[i].feecurrencyid in totalfees)
            totalfees[transfers[i].feecurrencyid] += transfers[i].fees;
        else
            totalfees[transfers[i].feecurrencyid] = transfers[i].fees;
    }
    for (let key in totalamounts) {
        cce.totalamounts.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalamounts[key]) : totalamounts[key]) });
    }
    for (let key in totalfees) {
        cce.totalfees.push({ "currency": key, "amount": (jsonready ? util.uint64ToVerusFloat(totalfees[key]) : totalfees[key]) });
    }

    cce.totalburned = [{ "currency": '0x0000000000000000000000000000000000000000', "amount": 0 }];
    cce.rewardaddress = {};
    cce.firstinput = 1;
    return cce;
}

/** core functions */

exports.getInfo = async() => {
    //getinfo is just tested to see that its not null therefore we can just return the version
    //check that we can connect to Ethereum if not return null to kill the connection
    try {

        var d = new Date();
        var timenow = d.valueOf();
        let cacheGetInfo = await getCachedApi('getInfo');
        let getInfo = cacheGetInfo ? JSON.parse(cacheGetInfo) : null;

        if (globaltimedelta + globallastinfo < timenow || !getInfo) {
            globallastinfo = timenow;
            let info = await verusBridgeMaster.methods.getinfo().call();

            let decodedParams = abi.decodeParameters(
                ['uint256', 'string', 'uint256', 'uint256', 'string', 'bool'],
                "0x" + info.slice(66));

            getinfo = {
                "version": decodedParams[0],
                "name": decodedParams[4],
                "VRSCversion": decodedParams[1],
                "blocks": decodedParams[2],
                "tiptime": decodedParams[3],
                "testnet": decodedParams[5],
            }
            console.log("Command: getinfo");
            await setCachedApi(getinfo, 'getInfo');
        }

        return { "result": getinfo };
    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "Error getInfo:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

exports.getCurrency = async(input) => {

    try {
        let currency = input[0];
        var d = new Date();
        var timenow = d.valueOf();
        let cacheGetCurrency = await getCachedApi('getCurrency');
        let getCurrency = cacheGetCurrency ? JSON.parse(cacheGetCurrency) : null;

        if (globaltimedelta + globallastcurrency < timenow || !getCurrency) {

            globallastcurrency = timenow;
            let info = await verusBridgeMaster.methods.getcurrency(util.convertVerusAddressToEthAddress(currency)).call();
            let notaries = [];
            let abiPattern = ['uint', 'string', 'address', 'address', 'address', 'uint8', 'uint8', [
                ['uint8', 'bytes']
            ], 'address', 'uint', 'uint', 'uint256', 'uint256', 'address', 'address[]', 'uint']

            let decodedParams = abi.decodeParameters(abiPattern,
                "0x" + info.slice(66));

            for (let i = 0; i < decodedParams[14].length; i++) {
                notaries[i] = util.ethAddressToVAddress(decodedParams[14][i], IAddressBaseConst);
            }

            getcurrency = {
                "version": decodedParams[0],
                "name": decodedParams[1],
                "options": (decodedParams[1] === "VETH") ? 172 : 96,
                "currencyid": util.uint160ToVAddress(decodedParams[2], IAddressBaseConst),
                "parent": util.uint160ToVAddress(decodedParams[3], IAddressBaseConst),
                "systemid": util.uint160ToVAddress(decodedParams[4], IAddressBaseConst),
                "notarizationprotocol": decodedParams[5],
                "proofprotocol": decodedParams[6],
                "nativecurrencyid": { "address": '0x' + BigInt(decodedParams[7][1], IAddressBaseConst).toString(16), "type": decodedParams[7][0] },
                "launchsystemid": util.uint160ToVAddress(decodedParams[8], IAddressBaseConst),
                "startblock": decodedParams[9],
                "endblock": decodedParams[10],
                "initialsupply": decodedParams[11],
                "prelaunchcarveout": decodedParams[12],
                "gatewayid": util.uint160ToVAddress(decodedParams[13], IAddressBaseConst),
                "notaries": notaries,
                "minnotariesconfirm": decodedParams[15],
                "gatewayconvertername": "Bridge"
            };
            console.log("Command: getcurrency");
            await setCachedApi(getCurrency, 'getCurrency');
        }

        return { "result": getCurrency };
    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "getCurrency:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

exports.getExports = async(input) => {

    let output = [];
    const lastCTransferArray = await getCachedApi('lastgetExports');
    let chainname = input[0];
    let heightstart = input[1];
    let heightend = input[2];

    let srtInput = JSON.stringify(input);
    if (lastCTransferArray == srtInput) {

        return { "result": null };
    }

    heightstart = heightstart == 1 ? 0 : heightstart;

    try {
        //input chainname should always be VETH
        let poolavailable = await verusBridgeMaster.methods.isPoolAvailable().call();

        if (chainname != VerusSystemID) throw "i-Address not VRSCTEST";

        let exportSets = [];
        let tempExportset = [];
        if (parseInt(heightstart) == 0) {
            exportSets = await verusBridgeMaster.methods.getReadyExportsByRange(heightstart, heightend).call();
        } else {
            let range = parseInt(heightend) - parseInt(heightstart);
            const DELTA = 200;
            if (range > DELTA) {
                let tempstartheight = undefined;
                let tempendheight = undefined;
                let tempfloor = Math.floor(range / DELTA);
                let tempremaind = range % DELTA;

                for (let i = 0; i < tempfloor; i++) {
                    tempstartheight = parseInt(heightstart) + (i * DELTA);
                    tempendheight = parseInt(heightstart) + ((i + 1) * DELTA) - 1;
                    tempExportset.push(await verusBridgeMaster.methods.getReadyExportsByRange(tempstartheight, tempendheight).call());
                }
                if (tempremaind > 0) {
                    tempExportset.push(await verusBridgeMaster.methods.getReadyExportsByRange(tempendheight + 1, heightend).call());
                }

                for (let j = 0; j < tempExportset.length; j++) {
                    if (tempExportset[j].length > 0) {
                        for (const set of tempExportset[j])
                            exportSets.push(set);
                    }

                }

            } else {
                exportSets = await verusBridgeMaster.methods.getReadyExportsByRange(heightstart, heightend).call();
            }
        }
        
        console.log("Height end: ", heightend, "heightStart:", heightstart);

        for (let i = 0; i < exportSets.length; i++) {
            //loop through and add in the proofs for each export set and the additional fields
            let exportSet = exportSets[i];
            let outputSet = {};
            let poolLaunchedHeight = await verusNotorizerStorage.methods.poolAvailable(constants.BRIDGECURRENCYHEX).call();
            poolavailable = parseInt(poolLaunchedHeight) == 0 ? false : parseInt(poolLaunchedHeight) < parseInt(exportSet.blockHeight);
            outputSet.height = exportSet.blockHeight;
            outputSet.txid = util.removeHexLeader(exportSet.exportHash).match(/[a-fA-F0-9]{2}/g).reverse().join(''); //export hash used for txid
            outputSet.txoutnum = 0; //exportSet.position;
            outputSet.exportinfo = createCrossChainExport(exportSet.transfers, exportSet.blockHeight, true, poolavailable);
            outputSet.partialtransactionproof = await getProof(exportSet.blockHeight, heightend);

            //serialize the prooflet index 
            let components = createComponents(exportSet.transfers, parseInt(exportSet.blockHeight, 10), exportSet.prevExportHash, poolavailable);
            outputSet.partialtransactionproof = serializeEthFullProof(outputSet.partialtransactionproof).toString('hex') + components;

            //build transfer list
            //get the transactions at the index
            let test = await verusBridgeStorage.methods._readyExports(outputSet.height).call();
            outputSet.transfers = createOutboundTransfers(exportSet.transfers);
            console.log("ETH Send to Verus: ", outputSet.transfers[0].currencyvalues, " to ", outputSet.transfers[0].destination);
            //loop through the 
            output.push(outputSet);
        }

        if (debugsubmit) {
            console.log(JSON.stringify(output, null, 2));
        }

        await setCachedApi(input, 'lastgetExports');
        return { "result": output };
    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "GetExports error:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

exports.getBestProofRoot = async(input) => {
    //loop through the proofroots and check each one

    let proofroots = input[0].proofroots;
    let bestindex = 0;
    let validindexes = [];
    let latestproofroot = {};
    var d = new Date();
    var timenow = d.valueOf();
    const lastTime = await getCachedApi('lastBestProofinputtime');

    let cachedValue = await checkCachedApi('lastGetBestProofRoot', input);

    if (cachedValue) {

        if (lastTime && (JSON.parse(lastTime) + globaltimedelta) < timenow) {

            clearCachedApis();
            cachedValue = null;
        }
    }

    if (cachedValue) {
        return cachedValue;
    }

    await setCachedApi(timenow, 'lastBestProofinputtime');
    try {
        if (input.length && proofroots) {
            for (let i = 0; i < proofroots.length; i++) {
                if ((parseInt(proofroots[i].height) > 1) && await checkProofRoot(proofroots[i].height, proofroots[i].stateroot, proofroots[i].blockhash, BigInt(util.addBytesIndicator(proofroots[i].power)))) {
                    validindexes.push(i);
                    if (proofroots[bestindex].height < proofroots[i].height) {
                        bestindex = i;
                    }
                }
            }
        }

        let latestProofHeight = proofroots[bestindex].height;
        let latestBlock = await web3.eth.getBlockNumber();

        if (parseInt(latestProofHeight) >= (parseInt(latestBlock) - 2)) {
            latestproofroot = proofroots[bestindex];
        } else {
            latestproofroot = await getProofRoot(latestBlock - 2);
        }

        let laststableproofroot = null;

        laststableproofroot = await getProofRoot(parseInt(latestBlock) - 30);

        if (logging) {
            console.log("getbestproofroot result:", { bestindex, validindexes, latestproofroot, laststableproofroot });
        }

        let retval = { "result": { bestindex, validindexes, latestproofroot, laststableproofroot} };

        await setCachedApiValue(retval, input, 'lastGetBestProofRoot');

        return retval;

    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "getBestProofRoot error:" + error);
        return { "result": { "error": true, "message": error } };
    }
}

async function getProofRoot(height = "latest") {

    let block;
    let transaction;
    let latestproofroot = {};

    const cachedBlock = await getCachedBlock(`${height}`);
    if (!cachedBlock)
    {
        try {
            block = await web3.eth.getBlock(height);
            transaction = await web3.eth.getTransaction(block.transactions[Math.ceil(block.transactions.length / 2)]);
        } catch (error) {
            throw "getProofRoot error:" + error;
        }
        
        let gasPriceInWei = new util.BigDecimal(transaction.gasPrice)
        let gasInSats =  gasPriceInWei.divide("10000000000");
        let roundedSats = Math.ceil(gasInSats.toString());

        latestproofroot.gasprice = util.uint64ToVerusFloat(roundedSats == 0 ? "0.00000001" : roundedSats);
        latestproofroot.version = 1;
        latestproofroot.type = 2;
        latestproofroot.systemid = ETHSystemID;
        latestproofroot.height = block.number;
        latestproofroot.stateroot = util.removeHexLeader(block.stateRoot).match(/[a-fA-F0-9]{2}/g).reverse().join('');
        latestproofroot.blockhash = util.removeHexLeader(block.hash).match(/[a-fA-F0-9]{2}/g).reverse().join('');
        latestproofroot.power = BigInt(block.totalDifficulty).toString(16);

        await setCachedBlock( latestproofroot, `${height}` )
        
    }
    else
    {
        latestproofroot = JSON.parse(cachedBlock);
    }
    
    if (debug)
        console.log("getProofRoot GASPRICE: " + latestproofroot.gasprice + ", height: " + height)

    return latestproofroot;

}

async function checkProofRoot(height, stateroot, blockhash, power) {

    
    let block;
    let transaction;
    let latestproofroot = {};

    const cachedBlock = await getCachedBlock(`${height}`);
    if (!cachedBlock)
    {
        try {
            block = await web3.eth.getBlock(height);
            transaction = await web3.eth.getTransaction(block.transactions[Math.ceil(block.transactions.length / 2)]);
        } catch (error) {
            throw "getProofRoot error:" + error;
        }
        
        let gasPriceInWei = new util.BigDecimal(transaction.gasPrice)
        let gasInSats =  gasPriceInWei.divide("10000000000");
        let roundedSats = Math.ceil(gasInSats.toString());

        latestproofroot.gasprice = util.uint64ToVerusFloat(roundedSats == 0 ? "0.00000001" : roundedSats);
        latestproofroot.version = 1;
        latestproofroot.type = 2;
        latestproofroot.systemid = ETHSystemID;
        latestproofroot.height = block.number;
        latestproofroot.stateroot = util.removeHexLeader(block.stateRoot).match(/[a-fA-F0-9]{2}/g).reverse().join('');
        latestproofroot.blockhash = util.removeHexLeader(block.hash).match(/[a-fA-F0-9]{2}/g).reverse().join('');
        latestproofroot.power = BigInt(block.totalDifficulty).toString(16);

        await setCachedBlock( latestproofroot, `${height}` )
        
    }
    else
    {
        latestproofroot = JSON.parse(cachedBlock);
    }
    
    if (debug)
        console.log("checkProofRoot GASPRICE: " + latestproofroot.gasprice + ", height: " + height)


    return (latestproofroot.stateroot == stateroot && latestproofroot.blockhash == blockhash && latestproofroot.power == BigInt(power).toString(16))
}

//return the data required for a notarisation to be made
exports.getNotarizationData = async() => {

    let Notarization = {};
    Notarization.version = 2;

    var d = new Date();
    var timenow = d.valueOf();

    const lastTime = await getCachedApi('lastgetNotarizationDatatime');

    if (lastTime && (JSON.parse(lastTime) + globaltimedelta) > timenow) {
        let tempNotData = await getCachedApi('lastgetNotarizationData');
        if (tempNotData) {
            return JSON.parse(tempNotData);
        }
    }

    await setCachedApi(timenow, 'lastgetNotarizationDatatime');

    try {
        let forksData = [];
        let forks = [];
        let j = 0
        let notarizations = {};
        let largestIndex = 0;

        let calcIndex = 0;
        try {
            while (true) {
                let notarization = await verusNotarizer.methods.bestForks(j).call();
                notarization = util.removeHexLeader(notarization);
                if (notarization && notarization.length >= constants.LIF.FORKLEN) {
                    let length = notarization.length / constants.LIF.FORKLEN;

                    for (let i = 0; length > i; i++) {

                        let hashPos = constants.LIF.HASHPOS + (i * constants.LIF.FORKLEN);
                        let txidPos = constants.LIF.TXIDPOS + (i * constants.LIF.FORKLEN);
                        let nPos = constants.LIF.NPOS + (i * constants.LIF.FORKLEN);
                        if (largestIndex < calcIndex)
                        {
                            largestIndex = calcIndex;
                            Notarization.bestchain = j;
                        }
                       
                        if ((j == 0  && i == 0) || i > 0) 
                        {
                            notarizations[calcIndex] = {
                                txid: "0x" + notarization.substring(txidPos, txidPos + constants.LIF.BYTES32SIZE).match(/[a-fA-F0-9]{2}/g).reverse().join(''),
                                n: parseInt(notarization.slice(nPos, nPos + 4), constants.LIF.HEX),
                                hash: "0x" + notarization.substring(hashPos, hashPos + constants.LIF.BYTES32SIZE).match(/[a-fA-F0-9]{2}/g).reverse().join('')
                            };
                            forksData.push(calcIndex);
                            calcIndex++;
                        }
                        else{
                            forksData.push(0);
                        }

                    }
                    forks.push(forksData);
                    forksData = [];
                    j++;
                } else
                    break;
            }
        } catch (e) {

        }

        if (forks.length == 0) {
            Notarization.forks = [];
            Notarization.lastconfirmed = -1;
            Notarization.bestchain = 0;
        } else {
            Notarization.forks = forks;
            Notarization.lastconfirmed = 0;
            Notarization.notarizations = [];

            for (const index in notarizations) {
                Notarization.notarizations.push({
                    index: parseInt(index),
                    txid: util.removeHexLeader(notarizations[index].txid),
                    vout: notarizations[index].n,
                });
            }
        }

        if (debug) {
            console.log("NOTARIZATION CONTRACT INFO \n" + JSON.stringify(Notarization, null, 2))
        }

        await setCachedApi({ "result": Notarization }, 'lastgetNotarizationData');

        return { "result": Notarization };

    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "getNotarizationData: (No spend tx) S" + error);
        return { "result": { "error": true, "message": error } };
    }
}

function conditionSubmitImports(CTransferArray) {

    for (let i = 0; i < CTransferArray.length; i++) {

        CTransferArray[i].notarizationtxid = addHexPrefix(CTransferArray[i].notarizationtxid);
        CTransferArray[i].sourcesystemid = util.convertVerusAddressToEthAddress(CTransferArray[i].sourcesystemid);
        for (let j = 0; j < CTransferArray[i].exports.length; j++) {
            CTransferArray[i].exports[j].partialtransactionproof = addHexPrefix(CTransferArray[i].exports[j].partialtransactionproof);
            CTransferArray[i].exports[j].txid = addHexPrefix(CTransferArray[i].exports[j].txid.match(/[a-fA-F0-9]{2}/g).reverse().join(''));
            for (let k = 0; k < CTransferArray[i].exports[j].transfers.length; k++) {

                let keys = Object.keys(CTransferArray[i].exports[j].transfers[k].currencyvalues);

                for (const vals of keys) {
                    CTransferArray[i].exports[j].transfers[k].currencyvalues[util.convertVerusAddressToEthAddress(vals)] =
                        parseInt(util.convertToInt64(CTransferArray[i].exports[j].transfers[k].currencyvalues[vals]));
                    delete CTransferArray[i].exports[j].transfers[k].currencyvalues[vals];
                }
                if (CTransferArray[i].exports[j].transfers[k].destination.type == 4 ||
                    CTransferArray[i].exports[j].transfers[k].destination.type == 2) //type PKH or ID
                {
                    CTransferArray[i].exports[j].transfers[k].destination.address =
                        util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].destination.address);
                }
                if (CTransferArray[i].exports[j].transfers[k].destination.type == constants.DEST_REGISTERCURRENCY ||
                    CTransferArray[i].exports[j].transfers[k].destination.type == constants.DEST_FULLID) {

                    CTransferArray[i].exports[j].transfers[k].destination.address = "0x" + CTransferArray[i].exports[j].transfers[k].destination.serializeddata;
                }

                CTransferArray[i].exports[j].transfers[k].destinationcurrencyid =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].destinationcurrencyid);
                CTransferArray[i].exports[j].transfers[k].exportto =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].exportto);
                CTransferArray[i].exports[j].transfers[k].feecurrencyid =
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].feecurrencyid);
                CTransferArray[i].exports[j].transfers[k].fees =
                    parseInt(util.convertToInt64(CTransferArray[i].exports[j].transfers[k].fees));
                CTransferArray[i].exports[j].transfers[k].secondreserveid = CTransferArray[i].exports[j].transfers[k].secondreserveid ?
                    util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].secondreserveid) :
                    "0x0000000000000000000000000000000000000000"; //dummy value never read if not set as flags will not read.
                if (CTransferArray[i].exports[j].transfers[k].via) {
                    CTransferArray[i].exports[j].transfers[k].via =
                        util.convertVerusAddressToEthAddress(CTransferArray[i].exports[j].transfers[k].via);
                }
            }
        }
    }
    return CTransferArray;
}

function fixETHObjects(inputArray) {

    for (let i = 0; i < inputArray.length; i++) {

        let keys = Object.keys(inputArray[i].currencyvalues);

        for (var key of keys) {
            inputArray[i].currencyvalue = { "currency": key, "amount": inputArray[i].currencyvalues[key] };
        }
        delete inputArray[i].currencyvalues;

        inputArray[i].destination.destinationaddress = inputArray[i].destination.address
        inputArray[i].destination.destinationtype = inputArray[i].destination.type

        delete inputArray[i].destination.address;
        delete inputArray[i].destination.type;
        if ((parseInt(inputArray[i].flags) & 1024) == 1024) { // RESERVETORESERVE FLAG
            inputArray[i].destcurrencyid = inputArray[i].via;
            inputArray[i].secondreserveid = inputArray[i].destinationcurrencyid;
        } else {
            inputArray[i].destcurrencyid = inputArray[i].destinationcurrencyid;
        }
        delete inputArray[i].destinationcurrencyid;

        inputArray[i].destsystemid = inputArray[i].exportto;
        delete inputArray[i].exportto;


    }

    return inputArray;
}

function reshapeTransfers(CTransferArray) {
    let CTempArray = [];

    for (let i = 0; i < CTransferArray.length; i++) {
        for (let j = 0; j < CTransferArray[i].exports.length; j++) {

            const transfers = fixETHObjects(CTransferArray[i].exports[j].transfers);
            const serializedTransfers = serializeCReserveTransfers(transfers);
            if (i == -1)
                console.log("Serialized transfers: 0x", serializedTransfers.toString('hex'));
            let exportinfo = createCrossChainExportToETH(transfers);

            let subarray = {
                height: 1,
                txid: CTransferArray[i].exports[j].txid,
                txoutnum: CTransferArray[i].exports[j].txoutnum,
                exportinfo,
                partialtransactionproof: [CTransferArray[i].exports[j].partialtransactionproof],
                transfers: CTransferArray[i].exports[j].transfers,
                serializedTransfers: addHexPrefix(serializedTransfers.toString('hex'))
            };

            CTempArray.push(subarray);

            if (debug) {
                //let hashtest = ethersUtils.keccak2566(serializedTransfers);
                //console.log("Transfers hash: ", hashtest.toString('hex'));
            }
        }
    }

    return CTempArray;
}

exports.submitImports = async(CTransferArray) => {

    if (noaccount || noimports) {
        console.log("************** Submitimports: Wallet will not spend ********************");
        return { result: { error: true } };
    }

    const lastCTransferArray = await getCachedApi('lastsubmitImports');

    CTransferArray = conditionSubmitImports(CTransferArray);

    let CTempArray = reshapeTransfers(CTransferArray);

    if (lastCTransferArray === JSON.stringify(CTransferArray)) {

        return { result: globalsubmitimports.transactionHash };
    }

    CTempArray = deserializer.deSerializeMMR(CTempArray);

    CTempArray = deserializer.insertHeights(CTempArray);

    let submitArray = [];
    if (debugsubmit)
        console.log(JSON.stringify(CTempArray, null, 2))

    try {

        if (CTempArray.length > 0) {
            let processed = await verusBridgeMaster.methods.checkImport(CTempArray[0].txid).call();
            if (!processed) {
                submitArray.push(CTempArray[0])
            }
        }

        let testcall = await verusBridgeMaster.methods.submitImports(submitArray[0]).call(); //test call

        if (CTempArray)
        console.log("Transfer to ETH: " + JSON.stringify(CTempArray[0].transfers[0].currencyvalue, null,2) + "\nto: " + JSON.stringify(CTempArray[0].transfers[0].destination.destinationaddress, null, 2));

        await setCachedApi(CTransferArray, 'lastsubmitImports');
        if (submitArray.length > 0) {
            globalsubmitimports = await verusBridgeMaster.methods.submitImports(submitArray[0]).send({ from: account.address, gas: maxGas });
        } else {
            return { result: "false" };
        }
    } catch (error) {

        console.log(error);

        if (error.reason)
            console.log("\x1b[41m%s\x1b[0m", "submitImports:" + error.reason);
        else {
            if (error.receipt)
                console.log("\x1b[41m%s\x1b[0m", "submitImports:" + error.receipt);

            console.log("\x1b[41m%s\x1b[0m", "submitImports:" + error);
        }
        return { result: { result: error.message } };
    }

    return { result: globalsubmitimports.transactionHash };
}

exports.submitAcceptedNotarization = async(params) => {

    if (noaccount ) {
        console.log("************** submitAcceptedNotarization: Wallet will not spend ********************");
        return { result: { error: true } };
    }

    if (debugnotarization) {
        console.log(JSON.stringify(params[0], null, 2));
        console.log(JSON.stringify(params[1], null, 2));
    }

    const serializednotarization = notarization.serializeNotarization(params[0]);

    let signatures = {};

    let sigArray = {}

    for (const sigObj of params[1].evidence.chainobjects) {
        let sigKeys = Object.keys(sigObj.value.signatures);
        for (let i = 0; i < sigKeys.length; i++) {
            if (sigArray[sigObj.value.signatures[sigKeys[i]].blockheight] == undefined) {
                sigArray[sigObj.value.signatures[sigKeys[i]].blockheight] = [];
            }
            sigArray[sigObj.value.signatures[sigKeys[i]].blockheight].push({
                [sigKeys[i]]: sigObj.value.signatures[sigKeys[i]]
            });
        }
    }

    let sigArrayKeys = Object.keys(sigArray);
    let largestcount = 0;

    for (const heights of sigArrayKeys) {
        if (largestcount < parseInt(heights))
            largestcount = heights;
    }

    for (const items of sigArray[largestcount]) {
        let ID = Object.keys(items);
        signatures[ID[0]] = items[ID[0]];
    }

    let txidObj = params[1].output;
    const lastTxid = await getCachedApi('lastNotarizationTxid');

    try {

        if (lastTxid && lastTxid == JSON.stringify(txidObj.txid)) {
            return { "result": "0" };
        }

    } catch (error) {
        console.log("submitAcceptedNotarization Error:\n", error);
        return null;
    }

    let sigKeys = Object.keys(signatures);
    let splitSigs = {}
    let vsVals = [];
    let rsVals = [];
    let ssVals = [];
    let blockheights = [];
    let notaryAddresses = [];

    for (let i = 0; i < sigKeys.length; i++) {

        splitSigs = util.splitSignature(signatures[sigKeys[i]].signatures[0]);
        vsVals.push(splitSigs.vVal);
        rsVals.push(splitSigs.rVal);
        ssVals.push(splitSigs.sVal);
        blockheights.push(signatures[sigKeys[i]].blockheight);
        notaryAddresses.push(util.convertVerusAddressToEthAddress(sigKeys[i]));
    }

    try {
        let txhash = {}
        var firstNonce = await web3.eth.getTransactionCount(account.address);

        // Reduce contract size by serializing signature evidence
        let data = abi.encodeParameter({
            "data": {
                "_vs": 'uint8[]',
                "_rs": 'bytes32[]',
                "_ss": 'bytes32[]',
                "blockheights": "uint32[]",
                "notaryAddress": "address[]"
            }
        }, {
            "_vs": vsVals,
            "_rs": rsVals,
            "_ss": ssVals,
            "blockheights": blockheights,
            "notaryAddress": notaryAddresses
        });

        //remove first 32bytes + 0x from hex array, so abi.decode in contract recievces correct value.
        data = "0x" + data.slice(66); 
        // Call contract to test for reversion.
        let testValue = await verusBridgeMaster.methods.setLatestData(`0x${serializednotarization.toString('hex')}`, addHexPrefix(txidObj.txid.match(/[a-fA-F0-9]{2}/g).reverse().join('')), txidObj.voutnum, data).call();

        if (transactioncount != firstNonce) {
            txhash = await verusBridgeMaster.methods.setLatestData(`0x${serializednotarization.toString('hex')}`, addHexPrefix(txidObj.txid.match(/[a-fA-F0-9]{2}/g).reverse().join('')), txidObj.voutnum, data).send({ from: account.address, gas: maxGas });
            transactioncount = firstNonce;
        }

        await setCachedApi(txidObj.txid, 'lastNotarizationTxid');
        return { "result": txhash };

    } catch (error) {

        if (error.reason)
            console.log("\x1b[41m%s\x1b[0m", "submitAcceptedNotarization:" + error.reason);
        else if (error.message && error.message == "Returned error: already known") {
            console.log("Notarization already Submitted, transaction cancelled");
        } else {
            console.log(error);
        }
        return { "result": { "txid": error } }; 
    }
}

//return the data required for a notarisation to be made
exports.getLastImportFrom = async() => {

    //create a CProofRoot from the block data
    let cachelastImportFrom = await getCachedApi('lastImportFrom');
    let lastImportFrom = cachelastImportFrom ? JSON.parse(cachelastImportFrom) : null;

    try {
        var d = new Date();
        var timenow = d.getTime();
        if (globaltimedelta + globalgetlastimport < timenow || !lastImportFrom) {
            globalgetlastimport = timenow;

            block = await web3.eth.getBlock("latest");
            let lastimporttxid = await verusBridgeStorage.methods.lastTxIdImport().call();

            let lastImportInfo = await verusBridgeStorage.methods.lastImportInfo(lastimporttxid).call();

            let lastimport = {};

            lastimport.version = constants.LIF.VERSION;
            lastimport.flags = constants.LIF.FLAGS;
            lastimport.sourcesystemid = ETHSystemID;
            lastimport.sourceheight = parseInt(lastImportInfo.height);
            lastimport.importcurrencyid = ETHSystemID;
            lastimport.valuein = {};
            lastimport.tokensout = {};
            lastimport.numoutputs = {};

            lastimport.hashtransfers  = util.removeHexLeader(lastImportInfo.hashOfTransfers).match(/[a-fA-F0-9]{2}/g).reverse().join('');
            lastimport.exporttxid = util.removeHexLeader(lastImportInfo.exporttxid).match(/[a-fA-F0-9]{2}/g).reverse().join('');
            lastimport.exporttxout = lastImportInfo.exporttxoutnum;

            let forksData = {};
            let lastconfirmednotarization = {};
            let lastconfirmedutxo = {};
            try {
                forksData = await verusNotarizer.methods.bestForks(0).call();
                forksData = util.removeHexLeader(forksData);

                let txidPos = constants.LIF.TXIDPOS;
                let nPos = constants.LIF.NPOS;
                let txid = "0x" + forksData.substring(txidPos, txidPos + constants.LIF.BYTES32SIZE).match(/[a-fA-F0-9]{2}/g).reverse().join('');
                let n = parseInt(forksData.substring(nPos, nPos + 4), constants.LIF.HEX);

                lastconfirmedutxo = { txid: util.removeHexLeader(txid), voutnum: n }

            } catch (e) {
                console.log("\x1b[41m%s\x1b[0m", "No Notarizations recieved yet");
            }
            lastImportFrom = { "result": { lastimport, lastconfirmednotarization, lastconfirmedutxo } }
            await setCachedApi(lastImportFrom, 'lastImportFrom');
        }

        return lastImportFrom;
    } catch (error) {
        console.log("\x1b[41m%s\x1b[0m", "getLastImportFrom:" + error);
        return { "result": { "error": true, "message": error } };
    }

}

exports.invalid = async() => {
    console.log("\x1b[41m%s\x1b[0m", "Invalid API call");
    return { "result": { "error": true, "message": "Unrecognized API call" } }

}