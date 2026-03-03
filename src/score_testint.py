
# NFL Import
from espn_api.baseball import League
# public league
league = League(league_id=37734, year=2023, espn_s2='AECsp1a8Ep7qxziJuAauNS6ApToh3M9jUbx2XnVKc%2BlJGJeROUCblElUtw%2BHER8IJD3HglE6XSinTkJqqf%2BD%2B2OZ6LcDxqQaDolq0JW4oM8D%2FJscyMQAwyCoIYGJKIpy2xAF%2FvHtErDYuv22Uh5YNMgZPuUIrGtUlJUo0tW9%2Fzq%2FH3mbytHOTbCaZTV%2BVX%2Fg9NMBR8UNasI7%2F95q1h1DmhXKPgc2Wa%2BXpqDHDU8HvJCvMCqKSW6lXNTs7RQ%2FEXh11eNVDVbS1SDmk3JU1u5qwoKkzzj7ZroH5yAEu11cZIoHBA%3D%3D', swid='{EEFDF804-ED17-4981-BDF8-04ED173981C0}')
league.teams

# Initialize a dictionary to hold team scores per week, including team abbreviations
team_scores = {}

# Loop through each week of the season
for week in range(1, 20):  # Assuming weeks are numbered from 1 to 19
    # Fetch the matchups for the current week
    week_matchups = league.scoreboard(week)
    
    # Iterate over the matchups to extract team scores and abbreviations
    for matchup in week_matchups:
        # Extract the home team information
        home_team_info = (matchup.home_team.team_name, matchup.home_team.team_abbrev)
        if home_team_info not in team_scores:
            team_scores[home_team_info] = []
        team_scores[home_team_info].append(matchup.home_final_score)
        
        # Extract the away team information
        away_team_info = (matchup.away_team.team_name, matchup.away_team.team_abbrev)
        if away_team_info not in team_scores:
            team_scores[away_team_info] = []
        team_scores[away_team_info].append(matchup.away_final_score)


# Determine the number of weeks in the season
num_weeks = 19

# Print the header row with week numbers
header_row = ["Team", "Abbrev"] + [f"Week {i+1}" for i in range(num_weeks)]
print("{:<20}{:<10}".format(header_row[0], header_row[1]) + ''.join(["{:<10}".format(week) for week in header_row[2:]]))

# Iterate over each team and their scores, printing them in table rows
for (team_name, team_abbrev), scores in team_scores.items():
    # Pad the scores list with empty strings if any weeks are missing data
    scores += [''] * (num_weeks - len(scores))
    # Print the team name, abbreviation, and their scores for each week
    print("{:<20}{:<10}".format(team_name, team_abbrev) + ''.join(["{:<10}".format(score) for score in scores]))
