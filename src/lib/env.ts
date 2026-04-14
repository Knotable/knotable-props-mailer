const getEnvVar = (key: string, options: { required?: boolean } = {}) => {
  const value = process.env[key];
  if (options.required && (!value || value.length === 0)) {
    throw new Error(`Missing required env var ${key}`);
  }
  return value;
};

export const env = {
  appBaseUrl: getEnvVar("APP_BASE_URL") ?? "http://localhost:3000",
  supabase: {
    url: getEnvVar("NEXT_PUBLIC_SUPABASE_URL"),
    anonKey: getEnvVar("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
    serviceRoleKey: getEnvVar("SUPABASE_SERVICE_ROLE_KEY"),
    jwtSecret: getEnvVar("SUPABASE_JWT_SECRET"),
  },
  mailgun: {
    apiKey: getEnvVar("MAILGUN_API_KEY"),
    signingKey: getEnvVar("MAILGUN_SIGNING_KEY"),
    domain: getEnvVar("MAILGUN_DOMAIN"),
  },
};
