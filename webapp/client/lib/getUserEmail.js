export function getUserEmail(user) {
  return user.emails && user.emails[0]?.address;
}
