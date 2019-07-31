const {getActionsV1Schema} = require("../../schemas");
const {getCacheByHash} = require("../../helpers/functions");
const _ = require('lodash');
const fetch = require('node-fetch');
const {JsonRpc} = require('eosjs');
const eos_endpoint = process.env.NODEOS_HTTP;
const rpc = new JsonRpc(eos_endpoint, {fetch});

const maxActions = 1000;
const route = '/get_actions';
const terms = ["notified", "act.authorization.actor"];
const extendedActions = new Set(["transfer", "newaccount", "updateauth"]);

async function getActions(fastify, request) {
    const t0 = Date.now();
    const {redis, elastic} = fastify;
    const [cachedResponse, hash] = await getCacheByHash(redis, route + JSON.stringify(request.query));
    if (cachedResponse) {
        return cachedResponse;
    }
    const should_array = [];
    for (const entry of terms) {
        const tObj = {term: {}};
        tObj.term[entry] = request.query.account;
        should_array.push(tObj);
    }
    let code, method, skip, limit, parent;
    let sort_direction = 'asc';
    let filterObj = [];
    if (request.query.filter) {
        const filters = request.query.filter.split(',');
        for (const filter of filters) {
            const obj = {bool: {must: []}};
            const parts = filter.split(':');
            if (parts.length === 2) {
                [code, method] = parts;
                if (code && code !== "*") {
                    obj.bool.must.push({'term': {'act.account': code}});
                }
                if (method && method !== "*") {
                    obj.bool.must.push({'term': {'act.name': method}});
                }
            }
            filterObj.push(obj);
        }
    }
    skip = parseInt(request.query.skip, 10);
    if (skip < 0) {
        return 'invalid skip parameter';
    }
    limit = parseInt(request.query.limit, 10);
    if (limit < 1) {
        return 'invalid limit parameter';
    }

    if (request.query.sort) {
        if (request.query.sort === 'asc' || request.query.sort === '1') {
            sort_direction = 'asc';
        } else if (request.query.sort === 'desc' || request.query.sort === '-1') {
            sort_direction = 'desc'
        } else {
            return 'invalid sort direction';
        }
    }

    const queryStruct = {
        "bool": {
            must: [],
            boost: 1.0
        }
    };

    if(request.query.parent !== undefined) {
        queryStruct.bool['filter'] = [];
        queryStruct.bool['filter'].push({
            "term": {
                "parent": parseInt(request.query.parent, 10)
            }
        });
    }

    if (request.query.account) {
        queryStruct.bool.must.push({"bool": {should: should_array}});
    }

    for (const prop in request.query) {
        if (Object.prototype.hasOwnProperty.call(request.query, prop)) {
            const actionName = prop.split(".")[0];
            if (prop.split(".").length > 1) {
                if (extendedActions.has(actionName)) {
                    // console.log(prop + " = " + request.query[prop]);
                    const _termQuery = {};
                    _termQuery["@" + prop] = request.query[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                } else {
                    const _termQuery = {};
                    _termQuery[prop] = request.query[prop];
                    queryStruct.bool.must.push({term: _termQuery});
                }
            }
        }
    }

    if (request.query['after'] || request.query['before']) {
        let _lte = "now";
        let _gte = 0;
        if (request.query['before']) {
            _lte = request.query['before'];
        }
        if (request.query['after']) {
            _gte = request.query['after'];
        }
        if (!queryStruct.bool['filter']) {
            queryStruct.bool['filter'] = [];
        }
        queryStruct.bool['filter'].push({
            range: {
                "@timestamp": {
                    "gte": _gte,
                    "lte": _lte
                }
            }
        });
    }

    if (request.query.filter) {
        queryStruct.bool['should'] = filterObj;
        queryStruct.bool['minimum_should_match'] = 1;
    }

    const pResults = await Promise.all([rpc.get_info(), elastic['search']({
        "index": process.env.CHAIN + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": {
            "track_total_hits": 10000,
            "query": queryStruct,
            "sort": {
                "global_sequence": sort_direction
            }
        }
    })]);
    console.log(JSON.stringify({
        "index": process.env.CHAIN + '-action-*',
        "from": skip || 0,
        "size": (limit > maxActions ? maxActions : limit) || 10,
        "body": {
            "track_total_hits": 10000,
            "query": queryStruct,
            "sort": {
                "global_sequence": sort_direction
            }
        }
    }))
    const results = pResults[1];
    const response = {
        query_time: null,
        last_irreversible_block: pResults[0].last_irreversible_block_num,
        total: results['body']['hits']['total'],
        time_limit_exceeded_error: true,
        actions: []
    };
    if (results['body']['hits']['hits'].length > 0) {
        const actions = results['body']['hits']['hits'];
        actions.forEach((action, index) => {
            action = action._source;
            let act = {
                "global_action_seq": action.global_action_seq,
                "account_action_seq": index,
                "block_num": action.block_num,
                "block_time": action['@timestamp'],
                "action_trace": {
                    "receipt": {},
                    "act": {},
                    "elapsed": 0,
                    "console": "",
                    "trx_id": action.trx_id,
                    "block_num": action.block_num,
                    "block_time": action['@timestamp'],
                    "producer_block_id": "0179a85a84320e8a2ae26e7d9d3a899834a260c89266f8cbcaf94e2a5c221029",
                    "account_ram_deltas": [],
                    "except": null,
                    "inline_traces": []
                }
            }
            
            const name = action.act.name;
            if (action['@' + name]) {
                action['act']['data'] = _.merge(action['@' + name], action['act']['data']);
                delete action['@' + name];
            }
            act.action_trace.act = action.act
            act.action_trace.act.hex_data = ""
            response.actions.push(act);
        })
    }
    response['query_time'] = Date.now() - t0;
    redis.set(hash, JSON.stringify(response), 'EX', 30);
    return response;
}

module.exports = function (fastify, opts, next) {
    fastify.get('/get_actions', {
        schema: getActionsV1Schema.GET
    }, async (request) => {
        return await getActions(fastify, request);
    });
    next()
};
