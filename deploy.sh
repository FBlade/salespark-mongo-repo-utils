cd C:/GitHub/@salespark/mongo-repo-utils

red=$'\e[1;31m'
grn=$'\e[1;32m'
yel=$'\e[1;33m'
blu=$'\e[1;34m'
mag=$'\e[1;35m'
cyn=$'\e[1;36m'
end=$'\e[0m'

reset=`tput sgr0`

echo "${yel}"
echo "--------------------------------------------------"
echo "GRUNT bump (Update version)"
echo "--------------------------------------------------${reset}"
grunt bump:patch

echo " "
echo "${yel}"
echo "--------------------------------------------------"
echo "GIT add"
echo "--------------------------------------------------${reset}"
git add .

echo " "
echo "${yel}"
echo "--------------------------------------------------"
echo "GIT commit"
echo "--------------------------------------------------${reset}"
aicommits --prompt "Ignore version bumps, dependency updates, lock files, and deployment helper scripts such as deploy-beta-fast.sh. Focus only on meaningful functional or structural changes."

echo " "
echo "${yel}"
echo "--------------------------------------------------"
echo "GIT push (branch atual)"
echo "--------------------------------------------------${reset}"
branch=$(git rev-parse --abbrev-ref HEAD)
git push --set-upstream origin "$branch"


echo " "
echo "${yel}"
echo "--------------------------------------------------"
echo "Publish to npm (@salespark)"
echo "--------------------------------------------------${reset}"
if ! npm whoami >/dev/null 2>&1; then
  npm login
fi
npm publish --access public

echo " "
start https://www.npmjs.com/package/@salespark/mongo-repo-utils
echo " "


echo " "
echo "${grn}"
echo "--------------------------------------------------"
echo "Concluído!"
echo "--------------------------------------------------"

read -n 1 -s -r -p "Press any key to continue"
