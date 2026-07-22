export interface PipelinePrefixes {
  source: string;
  collection: string;
  destination: string;
}

export interface Pipeline {
  slug: string;
  prefixes: PipelinePrefixes;
}

export const PIPELINES: Pipeline[] = [
  {
    slug: 'prod-stack',
    prefixes: {
      source: 'ZoopOne/prod-stack-pipeline/',
      collection: 'ZoopOne/prod-stack-pipeline/',
      destination: 'ZoopOne/prod-stack-pipeline/'
    }
  },
  {
    slug: 'mymotor-ads',
    prefixes: {
      source: 'ZoopOne/mymotor_ads_data/',
      collection: 'ZoopOne/mymotor_ads_data/',
      destination: 'ZoopOne/clickhouse_google_ads_data/'
    }
  },
  {
    slug: 'mymotor-db',
    prefixes: {
      source: 'ZoopOne/mymotor_db_data/',
      collection: 'ZoopOne/mymotor_db_data/',
      destination: 'ZoopOne/mymotor_clickhouse_data/'
    }
  },
  {
    slug: 'mymotor-ct-events',
    prefixes: {
      source: 'ZoopOne/mymotor_ct_events_data/',
      collection: 'ZoopOne/mymotor_ct_events_data/',
      destination: 'ZoopOne/mymotor_clickhouse_ct_data/'
    }
  },
  {
    slug: 'mymotor-ct-events-v2',
    prefixes: {
      source: 'ZoopOne/mymotor_clevertap_events_data/',
      collection: 'ZoopOne/mymotor_clevertap_events_data/',
      destination: 'ZoopOne/mymotor_clevertap_ch_events/'
    }
  },
  {
    slug: 'meta-mymotor',
    prefixes: {
      source: 'ZoopOne/meta_analytics_data/',
      collection: 'ZoopOne/meta_analytics_data/',
      destination: 'ZoopOne/meta_mymotor_data/'
    }
  },
  {
    slug: 'ev-hub',
    prefixes: {
      source: 'ZoopOne/ev_hub_data/',
      collection: 'ZoopOne/ev_hub_data/',
      destination: 'ZoopOne/clickhouse_ev_data/'
    }
  },
  {
    slug: 'ev-billing',
    prefixes: {
      source: 'ZoopOne/ev_billing_data/',
      collection: 'ZoopOne/ev_billing_data/',
      destination: 'ZoopOne/clickhouse_ev_billing_data/'
    }
  }
];

export function getPipeline(slug: string): Pipeline | undefined {
  return PIPELINES.find((p) => p.slug === slug);
}
