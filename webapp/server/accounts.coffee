Accounts.onCreateUser (options, user) ->
  
  # Request an access token from the Github OAuth.
  accessToken = user.services.github.accessToken
  result = undefined
  profile = undefined
  
  # Using the accessToken fetched above, get the user information.
  result = Meteor.http.get("https://api.github.com/user",
    params:
      access_token: accessToken

    headers:
      "User-Agent": "Meteor/1.0"
  )
  
  # In case of an error, just throw and exception and exit.
  throw result.error  if result.error
  
  # Build the profile object with the data we want to store about the 
  # user in the Mongo Database.
  profile = _.pick(result.data, "login", "name", "avatar_url", "url", "company", "blog", "location", "email", "bio", "html_url")
  
  # Fetch the all the repos using the accessToken
  repos = Meteor.http.get(Meteor.settings.github.repo_url,
    params:
      access_token: accessToken

    headers:
      "User-Agent": "Meteor/1.0"
  )
  
  # Extract only the names in an array for easy minupluation.
  names = _.pluck(repos.data, "name")
  
  # If the user doesn't have the requested repo in his list of repos, then
  # just quit.
  # Otherwise, set the user and return it.
  if names.indexOf(Meteor.settings.github.repo_access) is -1
    throw new Error("You don't have access")
  else
    user.profile = profile
    user

Accounts.registerLoginHandler (loginRequest) ->
  console.log "loginRequest:", loginRequest
  unless loginRequest.token
    return undefined
  user = Meteor.users.findOne({'services.invitation.loginToken': loginRequest.token})
  if user
    userId = user._id
    stampedToken = Accounts._generateStampedLoginToken()
    hashStampedToken = Accounts._hashStampedToken(stampedToken)
    console.log "#loginHandler token ##{hashStampedToken}"
    Meteor.users.update userId, {
      $push: {'services.resume.loginTokens': hashStampedToken}
    }

    result = {
      userId: userId,
      token: stampedToken.token
    }
    return result
  return undefined
