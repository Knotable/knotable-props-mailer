const domains = JSON.parse(process.env.MAILGUN_DOMAINS);

export const findDomainConfig = (predicate) => ({
  ...domains.find(predicate),
});

export const defaultDomainConfig = findDomainConfig(
  ({ isDefault }) => isDefault
);

export const findDomainConfigByDomain = (domain) =>
  findDomainConfig(({ domain: d }) => d === domain);

export const getDomains = () =>
  domains.map(({ sendingApiKey, ...rest }) => rest);
