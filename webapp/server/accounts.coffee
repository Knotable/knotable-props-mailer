Accounts.onCreateUser (options, user) ->
  { accessToken } = user.services.github
  githubApi = new GithubApi accessToken, "User-Agent": "Meteor/1.0"
  user.profile = _.pick githubApi.user(),
    "login", "name", "avatar_url", "url", "company", "blog", "location", "email", "bio", "html_url"
  user



Accounts.validateNewUser (user) ->
  { username, accessToken } = user.services.github
  { organization_name, repo_access, team } = Meteor.settings.github
  githubApi = new GithubApi accessToken, "User-Agent": "Meteor/1.0"
  try
    # For non developers we expect to see them in configured team
    console.log 'Try to access via team membership', { username, team }
    requiredMembership = githubApi.getTeamMembership team.id, username
    if requiredMembership.state isnt 'active'
      throw new Meteor.Error 'Access denied: membership state is not active'
  catch err
    console.log 'No access via team membership', { username, team }, err
    console.log 'Try to access as developer', { username, repo_access }
    repos = githubApi.getOrganizationRepos organization_name
    names = _.pluck repos, "name"
    # Let developers have access to the app if they have access to configured repo
    unless _.contains names, repo_access
      console.log 'No developers access allowed', { username, repo_access }
      throw new Meteor.Error 403, "To get it working you should have access to configured github team or repository"
  true



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
