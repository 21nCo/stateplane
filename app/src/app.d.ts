declare global {
  namespace App {
    interface Platform {
      env: {
        ORIGINALS: R2Bucket;
        STATEPLANE_ENV: string;
      };
    }
  }
}

export {};
