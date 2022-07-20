#=====================================
# Load external ZSH plugins with Znap
#=====================================

# Set up Znap
if [ ! -d ~/znap-plugins ]; then
    git clone --depth 1 -- https://github.com/marlonrichert/zsh-snap.git
    source zsh-snap/install.zsh
fi
source ~/znap-plugins/zsh-snap/znap.zsh

# Autocompletion
if [ ! -d ~/znap-plugins/zsh-autocomplete ]; then
    znap source marlonrichert/zsh-autocomplete
fi
source ~/znap-plugins/zsh-autocomplete/zsh-autocomplete.plugin.zsh


#=====================
# Set up Git commands
#=====================

# A bunch of fancy ZSH code to enable git integration. Taken from
# https://scriptingosx.com/2019/07/moving-to-zsh-06-customizing-the-zsh-prompt/
autoload -Uz vcs_info
setopt prompt_subst
zstyle ':vcs_info:*' enable git
precmd_vcs_info() { vcs_info }
precmd_functions+=( precmd_vcs_info )

# Set prompt to be "[current_branch] [parent_path/current_path]$"
# Here %b is the current branch name, and %F{xxx} ... %f colours the text
# colour xxx, where 170 is the colour "orchid" and 154 the colour
# "GreenYellow". See all colours available here:
# https://jonasjacek.github.io/colors/
zstyle ':vcs_info:git:*' formats '%F{170}[%b]%f '
PROMPT=\$vcs_info_msg_0_
PROMPT+='%F{154}%2~$ %f'


#=============================
# Set up general ZSH settings
# ============================

# Enable vi mode
bindkey -v

# Set up shell integration
test -e "${HOME}/.iterm2_shell_integration.zsh" && source "${HOME}/.iterm2_shell_integration.zsh"

# PDF creation using Pandoc
pdf(){
  pandoc $1 -o ${1:0:(-3)}.pdf;
  echo "Created ${1:0:(-3)}.pdf"
}


#==================================
# Set up general terminal settings
#==================================

# Set up PATH
PATH="$HOME/.poetry/bin:$PATH"
PATH="$HOME/Applications/nvim/bin:$PATH"
PATH="/opt/homebrew/bin:$PATH"
PATH="$HOME/.poetry/bin:$PATH"

# Ensure openblas has been set up, which is used for Numpy to work
OPENBLAS="$(brew --prefix openblas)"

# Enable MPS fallback
PYTORCH_ENABLE_MPS_FALLBACK="1"


#=======================
# Convenience shortcuts
#=======================

# Backup dotfiles
rc(){
  cd ~/gitsky/dotfiles
  git add .
  git commit -m "chore: Update dot files"
  git pull
  git push
  echo "Dot files synced up!"
  cd -
}

# Activate a virtual environment, or build it if it is not there
vv(){
    if [ ! -d '.venv' ]; then
        python3 -m venv .venv
        source .venv/bin/activate
        pip3 install --upgrade pip setuptools wheel
        if [ -f 'requirements.txt' ]; then
            pip3 install -r requirements.txt
        fi
    else
        source .venv/bin/activate
    fi
}

# Create new project
newproj(){
    if [ ! -d "$HOME/.venv" ]; then
        python3 -m venv "$HOME/.venv"
        source "$HOME/.venv/bin/activate"
        pip3 install --upgrade pip wheel setuptools
        pip3 install --upgrade cookiecutter
    else
        source "$HOME/.venv/bin/activate"
    fi
    if [ ! -d "$HOME/.cookiecutters/saattrupdan-template" ]; then
        cookiecutter gh:saattrupdan/saattrupdan-template -o "$HOME/gitsky"
    else
        cookiecutter saattrupdan-template -o "$HOME/gitsky"
    fi
    deactivate
    cd "$HOME/gitsky"
}


#=========
# Aliases
#=========

alias ls='exa'
alias vim='nvim'
alias gt='cd ~/gitsky'
alias pc='cd ~/pCloud\ Drive'
alias bb='/Applications/Brave\ Browser.app/Contents/MacOS/Brave\ Browser'
alias ll='ls -l'
alias la='ls -ah'
alias lla='ls -lah'
alias gs='git status --short'
alias ga='git add'
alias gd='git diff'
alias gb='git branches'
alias gc='git checkout'
alias gl='git log --graph --pretty=format:"%Cred%h%Creset -%C(yellow)%d%Creset %s %Cgreen(%cr) %C(bold blue)<%an>%Creset" --abbrev-commit --date=relative'
alias tcc='tmux -CC'
alias python='python3'
