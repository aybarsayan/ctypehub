import { got } from 'got';

import { ConfigService } from '@kiltprotocol/sdk-js';

import { configuration } from './configuration';
import { logger } from './logger';
import { sleep } from './sleep';

const { subscan } = configuration;

const SUBSCAN_MAX_ROWS = 100;
const QUERY_INTERVAL_MS = 1000;
const BLOCK_RANGE_SIZE = 100_000;

const subscanAPI = `https://${subscan.network}.api.subscan.io`;
const eventsListURL = `${subscanAPI}/api/v2/scan/events`;
const eventsParamsURL = `${subscanAPI}/api/scan/event/params`;
const headers = {
  'X-API-Key': subscan.secret,
};

/**
 * Structure of SubScan responses from `/api/v2/scan/events`.
 */
export interface EventsListJSON {
  code?: number;
  data: {
    count: number;
    events: Array<{
      block_timestamp: number; // UNIX-time in seconds
      event_id: string;
      event_index: string;
      extrinsic_hash: string;
      extrinsic_index: string;
      finalized: true;
      id: number;
      module_id: string;
      phase: number;
    }> | null;
  };
  generated_at?: number;
  message?: string;
}

/**
 * Structure of SubScan responses from `/api/scan/event/params`.
 */
export interface EventsParamsJSON {
  code: number;
  data: Array<{
    event_index: string;
    params: Array<{
      name?: string;
      type?: string;
      type_name: string;
      value: unknown;
    }>;
  }>;
  generated_at: number;
  message: string;
}

export async function getEvents({
  fromBlock,
  row = SUBSCAN_MAX_ROWS,
  eventId,
  ...parameters
}: {
  module: string; // Pallet name
  eventId: string; // Event emitted
  fromBlock: number;
  page: number;
  row?: number;
}) {
  const payloadForEventsListRequest = {
    ...parameters,
    event_id: eventId,
    block_range: `${fromBlock}-${fromBlock + BLOCK_RANGE_SIZE}`,
    order: 'asc',
    row,
    finalized: true,
  };

  logger.debug(
    'payloadForEventsListRequest: ' +
      JSON.stringify(payloadForEventsListRequest, null, 2),
  );

  const {
    data: { count, events },
  } = await got
    .post(eventsListURL, { headers, json: payloadForEventsListRequest })
    .json<EventsListJSON>();

  if (!events) {
    return { count };
  }

  const eventIndices = events.map((event) => event.event_index);

  const payloadForEventsParamsRequest = { event_index: eventIndices };
  logger.debug(
    'payloadForEventsParamsRequest: ' +
      JSON.stringify(payloadForEventsParamsRequest, null, 2),
  );

  const { data: eventsParameters } = await got
    .post(eventsParamsURL, { headers, json: payloadForEventsParamsRequest })
    .json<EventsParamsJSON>();

  const parsedEvents = events.map(
    // eslint-disable-next-line @typescript-eslint/naming-convention
    ({ event_index, block_timestamp, extrinsic_hash }) => {
      // Block number
      const block = parseInt(event_index.split('-')[0]);

      const params = eventsParameters.find(
        (detailed) => detailed.event_index === event_index,
      )?.params;
      if (!params || params.length === 0) {
        throw new Error(
          `Parameters could not be retrieved for event with index: ${event_index}`,
        );
      }

      return {
        block,
        blockTimestampMs: block_timestamp * 1000,
        params,
        extrinsicHash: extrinsic_hash,
      };
    },
  );

  logger.debug('parsedEvents: ' + JSON.stringify(parsedEvents, null, 2));

  return { count, events: parsedEvents };
}

export interface ParsedEvent {
  block: number;
  blockTimestampMs: number;
  params: EventsParamsJSON['data'][number]['params'];
  extrinsicHash: string;
}

/** Extends the `event` with the parameters parsed,
 *  so that the parameters value extraction is easier and more elegant.
 *
 * @param event
 * @returns the extended event
 */
function parseParams(event: ParsedEvent) {
  return {
    ...event,
    parsedParams: Object.fromEntries(
      event.params.map((param) => [param.type_name, param.value]),
    ),
  };
}

export async function* subScanEventGenerator(
  module: string,
  eventId: string,
  startBlock: number,
  transform?: (events: ParsedEvent[]) => Promise<ParsedEvent[]>,
) {
  if (subscan.network === 'NONE') {
    return;
  }

  const api = ConfigService.get('api');

  const currentBlock = (await api.query.system.number()).toNumber();

  // get events in batches until the current block is reached
  for (
    let fromBlock = startBlock;
    fromBlock < currentBlock;
    fromBlock += BLOCK_RANGE_SIZE
  ) {
    const parameters = {
      module,
      eventId,
      fromBlock,
    };

    const { count } = await getEvents({ ...parameters, page: 0, row: 1 });

    const blockRange = `${fromBlock} - ${fromBlock + BLOCK_RANGE_SIZE}`;

    if (count === 0) {
      logger.debug(
        `No new "${eventId}" events found on SubScan in block range ${blockRange}.`,
      );
      await sleep(QUERY_INTERVAL_MS);
      continue;
    }

    logger.debug(
      `Found ${count} new "${eventId}" events on SubScan for in block range ${blockRange}.`,
    );

    const pages = Math.ceil(count / SUBSCAN_MAX_ROWS) - 1;

    for (let page = pages; page >= 0; page--) {
      const { events } = await getEvents({ ...parameters, page });
      if (!events) {
        continue;
      }

      logger.debug(
        `Loaded page ${page} of "${eventId}" events in block range ${blockRange}.`,
      );
      // if defined, the transform function could modify (f.ex. add parameters)
      // the events, before yielding them
      for (const event of transform ? await transform(events) : events) {
        yield parseParams(event);
      }

      await sleep(QUERY_INTERVAL_MS);
    }
  }
}
