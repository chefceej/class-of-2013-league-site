# First doc


# commented google section out for now 
# import requests
# import gspread
# from oauth2client.service_account import ServiceAccountCredentials

# scope = ["https://spreadsheets.google.com/feeds",
#          "https://www.googleapis.com/auth/spreadsheets",
#          "https://www.googleapis.com/auth/drive.file",
#          "https://www.googleapis.com/auth/drive"]

# creds = ServiceAccountCredentials.from_json_keyfile_name("/Users/connorkraus/Documents/FantasyCodeProject/credentials/sheetsapijsonkey.json", scope)
# client = gspread.authorize(creds)

# sheet = client.open("GovernorsBowlHub").sheet1  # Replace "Your_Sheet_Name" with the name of your Google Sheet

import gspread
from oauth2client.service_account import ServiceAccountCredentials

# Define the scope for the OAuth2 request.
# These URLs indicate the areas of Google Sheets and Drive that the script will be able to access.
scope = [
    "https://spreadsheets.google.com/feeds",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/drive"
]

# Use the credentials file you downloaded from the Google Developer Console
# to authenticate and create the service client.
creds = ServiceAccountCredentials.from_json_keyfile_name("/Users/connorkraus/Documents/FantasyCodeProject/credentials/sheetsapijsonkey.json", scope)
client = gspread.authorize(creds)

# Open the specific Google Sheet by name
sheet = client.open("2025 League Standings").worksheet("scores_import")  # Make sure "GovernorsBowlHub" matches the exact name of your Google Sheet



# NFL Import
from espn_api.baseball import League
# public league
league = League(league_id=37734, year=2025, espn_s2='AECCtMzl9%2FUwP6qFaFVuGExQ5hMreSOxHPX4NpS%2FQsPqRZeNuDEIUC4zUR%2FmKSCv2ZODeVLqYTffutEqYdqsfhLjavBW2rAItLKCqCQuvPeDsR85qspcNoXEbBMHiwQkwSuA0IiyzDRGDW0L0HR0SydAKhpwU5vL7gC8JcJEmOHOEauprzzT56saXzJi%2F8djB8QQKFPKVN3lBmGvUNtH3jjZxhF0Laj5VpvKADwBQWyDW0EoN32UienLg9xC8K3inV3oeahnZFnzV0Nu8b7V42Y67eYmxRzJx4Pp8yi8oQra3Q%3D%3D', swid='{EEFDF804-ED17-4981-BDF8-04ED173981C0}')
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


#exporting to google sheets
    
# Prepare the header row with an additional 'Abbrev' column
header_row = ["Team", "Abbrev"] + [f"Week {i+1}" for i in range(num_weeks)]
data = [header_row]

# Prepare the data rows for each team
for (team_name, team_abbrev), scores in team_scores.items():
    # Pad the scores list with empty strings if any weeks are missing data
    scores += [''] * (num_weeks - len(scores))
    # Append the team name, abbreviation, and scores for each week to the data
    data.append([team_name, team_abbrev] + scores)

# Select the first sheet in your Google Sheets document
sheet = client.open("2025 League Standings").worksheet("scores_import")  # Make sure to replace "2024_scoring_test" with your actual sheet name

# Clear the existing content in the sheet
sheet.clear()

# Update the sheet with the new data
sheet.update('A1', data)  # This updates starting from cell A1















#     # Initialize points for the highest score
#     points = 12
    
#     # Iterate over the sorted scores and assign points
#     for team, score in week_scores_sorted:
#         if team not in team_rankings:
#             team_rankings[team] = []
#         team_rankings[team].append(points)
#         points = max(1, points - 1)  # Decrement points, ensuring they don't go below 1

# # Initialize a dictionary to hold the total points for each team
# total_points = {team: sum(points) for team, points in team_rankings.items()}


# # Sort the total_points dictionary by total points, from highest to lowest
# sorted_total_points = sorted(total_points.items(), key=lambda x: x[1], reverse=True)

# # Print the header
# print(f"{'Team':<20}", end='')
# for week in range(1, 20):
#     print(f"Wk{week:<3}", end='')
# print("Total")

# # Print the weekly points and total points for each team, now sorted by total points
# for team, _ in sorted_total_points:
#     print(f"{team:<20}", end='')
#     for point in team_rankings[team]:
#         print(f"{point:<4}", end='')
#     print(f"{total_points[team]:<5}")




# import numpy as np

# # Initialize a dictionary to hold the cumulative points for each team
# cumulative_points = {team: np.cumsum(points) for team, points in team_rankings.items()}


# import matplotlib.pyplot as plt

# num_weeks = 19  # Define the total number of weeks in the season

# # Set up the plot
# plt.figure(figsize=(14, 8))
# plt.title('Cumulative Team Points Over the Season')
# plt.xlabel('Week')
# plt.ylabel('Cumulative Points')

# # Plot each team's cumulative points
# for team, cum_points in cumulative_points.items():
#     plt.plot(range(1, num_weeks + 1), cum_points, label=team, marker='o')

# # Improve the chart
# plt.xticks(range(1, num_weeks + 1))  # Ensure there's a tick for every week
# plt.legend(loc='upper left', bbox_to_anchor=(1, 1))  # Move the legend out of the plot
# plt.grid(True, which='both', linestyle='--', linewidth=0.5)

# # Show the plot
# plt.tight_layout()
# plt.show()



















# printing box scores
#week1 = league.scoreboard(1)
#teams_scores = []
#
# for matchup in week1:
#     # Append home team name and score
#     teams_scores.append([matchup.home_team.team_name, matchup.home_final_score])
#     # Append away team name and score
#     teams_scores.append([matchup.away_team.team_name, matchup.away_final_score])

# # Assuming teams_scores is the list of [team_name, score] pairs

# # Sort the list by score in descending order
# teams_scores_sorted = sorted(teams_scores, key=lambda x: x[1], reverse=True)

# # Initialize points for the highest score
# points = 12

# # Iterate over the sorted list and assign points
# for team in teams_scores_sorted:
#     # Add the points as the third element in each sublist
#     team.append(points)
#     # Decrement points for the next team
#     points = max(1, points - 1)  # Ensure points don't go below 1

# # Now teams_scores_sorted contains [team_name, score, points] for each team
# for team in teams_scores_sorted:
#     print(team)




# # print(league.teams)
# #team = league.teams[1]
# #team.roster
# #print([team.roster])

