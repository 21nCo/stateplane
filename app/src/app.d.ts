declare global {
  namespace App {
    interface Platform {
      env: {
        ORIGINALS: R2Bucket;
        STATEPLANE_ENV: string;
        STATEPLANE_TEST_HTTP?: string;
        STATEPLANE_TEST_TOKEN?: string;
        STATEPLANE_TEST_OWNER?: string;
        STATEPLANE_TEST_CREDENTIAL?: string;
        STATEPLANE_TEST_DATABASE_URL?: string;
        STATEPLANE_TEST_CURSOR_SECRET?: string;
        STATEPLANE_TEST_CELL_ID?: string;
        STATEPLANE_TEST_STORAGE_TARGET?: string;
        AUTHORITY?: Hyperdrive;
      };
    }
  }
}

export {};
