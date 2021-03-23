cp ~/.*rc ~/gitsky/dotfiles
cp ~/.profile ~/gitsky/dotfiles
cp ~/backup_dotfiles.sh ~/gitsky/dotfiles
cd ~/gitsky/dotfiles
git add .
git commit -m "chore: Update dot files"
git pull
git push
cd -
cp ~/gitsky/dotfiles/.*rc ~/
cp ~/gitsky/dotfiles/.profile ~/
cp ~/gitsky/dotfiles/backup_dotfiles.sh ~/
echo "Dot files synced up!"'
